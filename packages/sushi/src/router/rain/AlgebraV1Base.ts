import {
  Address,
  Hex,
  Log,
  PublicClient,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiItem,
  parseEventLogs,
} from 'viem'
import { ChainId } from '../../chain/index.js'
import { Token } from '../../currency/index.js'
import { CLTick } from '../../tines/CLPool.js'
import { getCurrencyCombinations } from '../get-currency-combinations.js'
import {
  NUMBER_OF_SURROUNDING_TICKS,
  PoolFilter,
  StaticPoolUniV3,
} from '../liquidity-providers/UniswapV3Base.js'
import { RainDataFetcherOptions } from './RainDataFetcher.js'
import {
  RainV3Pool,
  UniV3EventsAbi,
  UniswapV3BaseProvider,
} from './UniswapV3Base.js'

export const AlgebraEventsAbi = [
  ...UniV3EventsAbi.slice(0, 5), // same as univ3 Swap, Mint, Collect, Burn, Flash events
  // algebra specific events
  parseAbiItem('event Fee(uint16 fee)'),
  parseAbiItem('event TickSpacing(int24 newTickSpacing)'),
  parseAbiItem(
    'event Pool(address indexed token0, address indexed token1, address pool)',
  ),
]

export const globalStateAbi = [
  {
    inputs: [],
    name: 'globalState',
    outputs: [
      { internalType: 'uint160', name: 'price', type: 'uint160' },
      { internalType: 'int24', name: 'tick', type: 'int24' },
      { internalType: 'uint16', name: 'fee', type: 'uint16' },
      {
        internalType: 'uint16',
        name: 'timepointIndex',
        type: 'uint16',
      },
      {
        internalType: 'uint8',
        name: 'communityFeeToken0',
        type: 'uint8',
      },
      {
        internalType: 'uint8',
        name: 'communityFeeToken1',
        type: 'uint8',
      },
      { internalType: 'bool', name: 'unlocked', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export abstract class AlgebraV1BaseProvider extends UniswapV3BaseProvider {
  override TICK_SPACINGS: Record<string, number> = {}
  override eventsAbi = AlgebraEventsAbi as any

  readonly BASE_FEE = 100
  DEFAULT_TICK_SPACING = 1
  gloablStateAbi = globalStateAbi

  // true Algebra V1 forks (eg QuickSwap V3) compress their tick table by the
  // tick spacing the same way univ3 does, so a table word covers
  // tickSpacing * 256 raw ticks, while newer Algebra forks (Integral, and
  // some V1 forks like Lynex V2) index the table by the raw tick
  compressedTickTable = false

  // tick table word index of the given tick, honoring compressedTickTable
  tickWord(tick: number, tickSpacing: number): number {
    return this.compressedTickTable
      ? Math.floor(tick / tickSpacing / 256)
      : bitmapIndex(tick, tickSpacing)
  }

  poolDeployer: Record<number, Address> = {}

  constructor(
    chainId: ChainId,
    web3Client: PublicClient,
    factory: Record<number, Address>,
    initCodeHash: Record<number, string>,
    tickLens: Record<number, Address>,
    poolDeployer: Record<number, Address>,
    isTest = false,
  ) {
    super(chainId, web3Client, factory, initCodeHash, tickLens, isTest)
    this.poolDeployer = poolDeployer
    if (!(chainId in this.poolDeployer)) {
      throw new Error(
        `${this.getType()} cannot be instantiated for chainid ${chainId}, no poolDeployer address`,
      )
    }
  }

  override async fetchPoolData(
    t0: Token,
    t1: Token,
    excludePools?: Set<string> | PoolFilter,
    options?: RainDataFetcherOptions,
  ): Promise<RainV3Pool[]> {
    let staticPools = this.getStaticPools(t0, t1)
    if (excludePools)
      staticPools = staticPools.filter((p) => !excludePools.has(p.address))

    const tradeId = this.getTradeId(t0, t1)
    if (!this.poolsByTrade.has(tradeId))
      this.poolsByTrade.set(
        tradeId,
        staticPools.map((pool) => pool.address.toLowerCase()),
      )

    // filter out cached pools
    // this ensures backward compatibility for original DataFetcher
    if (typeof options?.ignoreCache === 'boolean' && !options.ignoreCache) {
      staticPools = this.filterCachedPools(staticPools)
    }
    if (staticPools.length === 0) return []

    const globalStateData = {
      multicallAddress: this.client.chain?.contracts?.multicall3?.address!,
      allowFailure: true,
      blockNumber: options?.blockNumber,
      contracts: staticPools.map(
        (pool) =>
          ({
            address: pool.address,
            chainId: this.chainId,
            abi: this.gloablStateAbi,
            functionName: 'globalState',
          }) as const,
      ),
    } as const
    const globalState = await this.client
      .multicall(globalStateData)
      .catch((e) => {
        console.warn(
          `${this.getLogPrefix()} - INIT: multicall failed, message: ${
            e.message
          }`,
        )
        return undefined
      })

    const tickSpacings = await this.getTickSpacing(staticPools, options)

    const existingPools: RainV3Pool[] = []
    staticPools.forEach((pool, i) => {
      const poolAddress = pool.address.toLowerCase()
      if (globalState === undefined || !globalState[i]) {
        this.handleNullPool(poolAddress)
        return
      }
      let tickSpacing = this.DEFAULT_TICK_SPACING
      if (typeof tickSpacings?.[i]?.result === 'number') {
        tickSpacing = tickSpacings[i]!.result!
      }
      const sqrtPriceX96 = globalState[i]!.result?.[0] // price
      const tick = globalState[i]!.result?.[1] // tick
      if (!sqrtPriceX96 || sqrtPriceX96 === 0n || typeof tick !== 'number') {
        this.handleNullPool(poolAddress)
        return
      }
      const fee = globalState[i]!.result?.[2] // fee
      // zero is a valid fee, a plugin can set the base fee to 0
      if (typeof fee !== 'number') {
        this.handleNullPool(poolAddress)
        return
      }
      const activeTick = this.getActiveTick(tick, tickSpacing)
      if (typeof activeTick !== 'number') {
        this.handleNullPool(poolAddress)
        return
      }
      existingPools.push({
        ...pool,
        fee,
        sqrtPriceX96,
        activeTick,
        tickSpacing,
        ticks: new Map(),
        reserve0: 0n,
        reserve1: 0n,
        liquidity: 0n,
        blockNumber: options?.blockNumber ?? 0n,
        tick,
      })
    })

    return existingPools
  }

  override getStaticPools(t1: Token, t2: Token): StaticPoolUniV3[] {
    const allCombinations = getCurrencyCombinations(this.chainId, t1, t2)
    const currencyCombinations: [Token, Token][] = []
    allCombinations.forEach(([currencyA, currencyB]) => {
      if (currencyA && currencyB) {
        const tokenA = currencyA.wrapped
        const tokenB = currencyB.wrapped
        if (tokenA.equals(tokenB)) return
        currencyCombinations.push(
          tokenA.sortsBefore(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA],
        )
      }
    })
    return currencyCombinations.map(([currencyA, currencyB]) => ({
      address: getAlgebraPoolAddress(
        this.poolDeployer[this.chainId as keyof typeof this.poolDeployer]!,
        currencyA.wrapped.address,
        currencyB.wrapped.address,
        this.initCodeHash[
          this.chainId as keyof typeof this.initCodeHash
        ] as `0x${string}`,
      ),
      token0: currencyA,
      token1: currencyB,
      fee: this.BASE_FEE,
    }))
  }

  // algebra doesnt have the fee/ticks setup the same way univ3 has
  override async ensureFeeAndTicks(): Promise<boolean> {
    return true
  }

  // handle algebra specific pool creation event
  override handleFactoryEvents(log: Log): boolean {
    const factory =
      this.factory[this.chainId as keyof typeof this.factory]!.toLowerCase()
    const logAddress = log.address.toLowerCase()
    if (logAddress === factory) {
      try {
        const event = parseEventLogs({
          logs: [log],
          abi: AlgebraEventsAbi,
          eventName: 'Pool',
        })[0]!
        return this.nullPools.delete(event.args.pool.toLowerCase())
      } catch {}
    }
    return false
  }

  // handle extra events that Algebra has
  override otherEventCases(
    log: Log,
    event: Log<
      bigint,
      number,
      boolean,
      (typeof AlgebraEventsAbi)[number],
      true,
      typeof AlgebraEventsAbi,
      (typeof AlgebraEventsAbi)[number]['name']
    >,
    pool: RainV3Pool,
  ): void {
    switch (event.eventName) {
      case 'Fee': {
        if (log.blockNumber! >= pool.blockNumber) {
          pool.blockNumber = log.blockNumber!
          pool.fee = event.args.fee
        }
        break
      }
      case 'TickSpacing': {
        if (log.blockNumber! >= pool.blockNumber) {
          pool.blockNumber = log.blockNumber!
          pool.tickSpacing = event.args.newTickSpacing
        }
        break
      }
      default:
    }
  }

  /**
   * Calculates and returns the list of current ticks for the given pool
   */
  override getMaxTickDiapason(tick: number, pool: RainV3Pool): CLTick[] {
    const currentTickIndex = this.tickWord(tick, pool.tickSpacing)
    if (!pool.ticks.has(currentTickIndex)) return []
    let minIndex
    let maxIndex
    for (minIndex = currentTickIndex; pool.ticks.has(minIndex); --minIndex);
    for (maxIndex = currentTickIndex + 1; pool.ticks.has(maxIndex); ++maxIndex);
    if (maxIndex - minIndex <= 1) return []

    let poolTicks: CLTick[] = []
    for (let i = minIndex + 1; i < maxIndex; ++i)
      poolTicks = poolTicks.concat(pool.ticks.get(i)!)

    // raw ticks covered by one tick table word
    const wordSpan = this.compressedTickTable ? pool.tickSpacing * 256 : 256
    const tickStep = this.compressedTickTable ? pool.tickSpacing : 1
    const lowerUnknownTick = (minIndex + 1) * wordSpan - tickStep
    console.assert(
      poolTicks.length === 0 || lowerUnknownTick < poolTicks[0]!.index,
      'Error 236: unexpected min tick index',
    )
    poolTicks.unshift({
      index: lowerUnknownTick,
      DLiquidity: 0n,
    })
    const upperUnknownTick = maxIndex * wordSpan
    console.assert(
      poolTicks[poolTicks.length - 1]!.index < upperUnknownTick,
      'Error 244: unexpected max tick index',
    )
    poolTicks.push({
      index: upperUnknownTick,
      DLiquidity: 0n,
    })

    return poolTicks
  }

  /**
   * Fetches ticks capped at pool boundries of the given list of pools
   */
  override async getTicks(
    existingPools: RainV3Pool[],
    options?: RainDataFetcherOptions,
  ): Promise<Map<number, CLTick[]>[] | undefined> {
    const [minIndexes, maxIndexes] = this.getIndexes(existingPools)
    const wordList = existingPools.map((pool, i) => {
      const minIndex = minIndexes[i]!
      const maxIndex = maxIndexes[i]!

      return [
        pool,
        Array.from({ length: maxIndex - minIndex + 1 }, (_, i) => minIndex + i),
      ] as [RainV3Pool, number[]]
    })
    return await this.getTicksInner(wordList, options)
  }

  override getIndexes(existingPools: RainV3Pool[]): [number[], number[]] {
    const minIndexes = existingPools.map((pool) =>
      this.tickWord(
        pool.activeTick - NUMBER_OF_SURROUNDING_TICKS,
        pool.tickSpacing,
      ),
    )
    const maxIndexes = existingPools.map((pool) =>
      this.tickWord(
        pool.activeTick + NUMBER_OF_SURROUNDING_TICKS,
        pool.tickSpacing,
      ),
    )
    return [minIndexes, maxIndexes]
  }

  /**
   * Adds a new tick to the given pool's tick list
   */
  override addTick(tick: number, amount: bigint, pool: RainV3Pool) {
    const tickWord = this.tickWord(tick, pool.tickSpacing)
    const ticks = pool.ticks.get(tickWord)
    if (ticks !== undefined) {
      if (ticks.length === 0 || tick < ticks[0]!.index) {
        ticks.unshift({ index: tick, DLiquidity: amount })
        return
      }
      if (tick === ticks[0]!.index) {
        ticks[0]!.DLiquidity = ticks[0]!.DLiquidity + amount
        if (ticks[0]!.DLiquidity === 0n) ticks.splice(0, 1)
        return
      }

      let start = 0
      let end = ticks.length
      while (end - start > 1) {
        const middle = Math.floor((start + end) / 2)
        const index = ticks[middle]!.index
        if (index < tick) start = middle
        else if (index > tick) end = middle
        else {
          ticks[middle]!.DLiquidity = ticks[middle]!.DLiquidity + amount
          if (ticks[middle]!.DLiquidity === 0n) ticks.splice(middle, 1)
          return
        }
      }
      ticks.splice(start + 1, 0, { index: tick, DLiquidity: amount })
    }
  }

  /**
   * Gets triggered if a pool's current tick get changed after processing event logs,
   * this calculates the new tciks that need to be fetched from onchain which then
   * takes place when afterProcessLog() is called
   */
  override onPoolTickChange(tick: number, pool: RainV3Pool): number[] {
    const currentTickWord = this.tickWord(tick, pool.tickSpacing)
    const minWord = this.tickWord(
      tick - NUMBER_OF_SURROUNDING_TICKS,
      pool.tickSpacing,
    )
    const maxWord = this.tickWord(
      tick + NUMBER_OF_SURROUNDING_TICKS,
      pool.tickSpacing,
    )

    const direction = currentTickWord - minWord <= maxWord - currentTickWord
    const wordNumber = maxWord - minWord
    const newTicks: number[] = []
    for (let i = wordNumber; i >= 0; --i) {
      const wordIndex = currentTickWord + this.getJump(i, direction)
      const wordState = pool.ticks.get(wordIndex)
      if (wordState === undefined) newTicks.push(wordIndex)
    }
    return newTicks
  }
}

// from packages/extractor/src/AlgebraExtractor.ts
export function getAlgebraPoolAddress(
  poolDeployer: Address,
  tokenA: Address,
  tokenB: Address,
  initCodeHash: Hex,
): Address {
  const constructorArgumentsEncoded = encodeAbiParameters(
    [
      { name: 'TokenA', type: 'address' },
      { name: 'TokenB', type: 'address' },
    ],
    [tokenA, tokenB],
  )
  const create2Inputs = [
    '0xff',
    poolDeployer,
    keccak256(constructorArgumentsEncoded as Hex),
    initCodeHash,
  ]
  const sanitizedInputs = `0x${create2Inputs.map((i) => i.slice(2)).join('')}`

  return getAddress(`0x${keccak256(sanitizedInputs as Hex).slice(-40)}`)
}

export const bitmapIndex = (tick: number, _tickSpacing: number) => {
  return Math.floor(tick / 256)
}
