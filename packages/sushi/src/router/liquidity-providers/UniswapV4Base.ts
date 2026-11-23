import {
  type Address,
  type Hex,
  type PublicClient,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
} from 'viem'
import {
  uniswapV4PoolManagerAbi_Initialize,
  uniswapV4StateViewAbi_getLiquidity,
  uniswapV4StateViewAbi_getSlot0,
  uniswapV4StateViewAbi_getTickBitmap,
  uniswapV4StateViewAbi_getTickLiquidity,
} from '../../abi/index.js'
import type { ChainId } from '../../chain/index.js'
import { Native, type Token, WNATIVE_ADDRESS } from '../../currency/index.js'
import { type CLTick, type RToken, UniV4Pool } from '../../tines/index.js'
import type { DataFetcherOptions } from '../data-fetcher.js'
import { getCurrencyCombinations } from '../get-currency-combinations.js'
import { type PoolCode, UniV4PoolCode } from '../pool-codes/index.js'
import { LiquidityProvider } from './LiquidityProvider.js'
import { NUMBER_OF_SURROUNDING_TICKS } from './UniswapV3Base.js'

export interface UniswapV4FeeTier {
  /** in 1/1_000_000 fractions, 3000 = 0.3% */
  fee: number
  tickSpacing: number
}

/** the fee tiers the Uniswap V4 front end creates pools without hooks with */
export const UNISWAP_V4_DEFAULT_FEE_TIERS: UniswapV4FeeTier[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10_000, tickSpacing: 200 },
]

/** the native currency of a PoolKey */
export const UNISWAP_V4_NATIVE: Address =
  '0x0000000000000000000000000000000000000000'
export const UNISWAP_V4_ZERO_HOOKS: Address =
  '0x0000000000000000000000000000000000000000'
export const UNISWAP_V4_DYNAMIC_FEE_FLAG = 0x800000
// hooks address flags (v4-core Hooks.sol): a hook with one of these can change
// the fee, the pool state or the amounts of a swap, so tines cannot predict
// the swap result
const BEFORE_SWAP_FLAG = 1n << 7n
const BEFORE_SWAP_RETURNS_DELTA_FLAG = 1n << 3n
const AFTER_SWAP_RETURNS_DELTA_FLAG = 1n << 2n

export interface UniswapV4PoolKey {
  /** lowercase, UNISWAP_V4_NATIVE for the native currency */
  currency0: Address
  /** lowercase */
  currency1: Address
  /** the lp fee in 1/1_000_000 fractions, or UNISWAP_V4_DYNAMIC_FEE_FLAG */
  fee: number
  tickSpacing: number
  /** lowercase */
  hooks: Address
}

/** PoolId = keccak256(abi.encode(PoolKey)) */
export function computeUniswapV4PoolId({
  currency0,
  currency1,
  fee,
  tickSpacing,
  hooks,
}: UniswapV4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks',
      ),
      [
        currency0.toLowerCase() as Address,
        currency1.toLowerCase() as Address,
        fee,
        tickSpacing,
        hooks.toLowerCase() as Address,
      ],
    ),
  )
}

/**
 * Whether tines can simulate a swap of the pool exactly. A hook that runs
 * before a swap can change its fee, the pool state or its amounts, and a hook
 * that returns swap deltas changes the amounts, so such a pool is not
 * supported. A hook that runs only after a swap, or on initialize, liquidity
 * changes and donations, leaves the swap math as it is, it can still revert
 * a swap. A dynamic fee pool is not supported yet
 */
export function isUniswapV4PoolSupported({
  fee,
  hooks,
}: Pick<UniswapV4PoolKey, 'fee' | 'hooks'>): boolean {
  if (fee === UNISWAP_V4_DYNAMIC_FEE_FLAG) return false
  if (
    BigInt(hooks) &
    (BEFORE_SWAP_FLAG |
      BEFORE_SWAP_RETURNS_DELTA_FLAG |
      AFTER_SWAP_RETURNS_DELTA_FLAG)
  )
    return false
  return true
}

/**
 * The swap fee of a pool in 1/1_000_000 fractions, as v4-core
 * ProtocolFeeLibrary computes it: protocolFee + lpFee - protocolFee * lpFee
 * / 1_000_000. The protocol fee has one value per direction (the lower 12
 * bits for zeroForOne, the upper 12 bits for oneForZero), tines has one fee
 * per pool, so this is the higher of the two
 */
export function uniswapV4SwapFee(lpFee: number, protocolFee: number): number {
  const swapFee = (fee: number) =>
    fee === 0 ? lpFee : fee + lpFee - Math.floor((fee * lpFee) / 1_000_000)
  return Math.max(swapFee(protocolFee & 0xfff), swapFee(protocolFee >> 12))
}

/** a sorted token pair with the lowercase PoolKey currencies of its tokens */
export interface UniswapV4TokenPair {
  token0: RToken
  token1: RToken
  currency0: Address
  currency1: Address
}

/** a pool that may exist: its PoolKey, id and tokens */
export interface UniswapV4StaticPool extends UniswapV4PoolKey {
  /** lowercase */
  id: Hex
  token0: RToken
  token1: RToken
}

/** the state of an existing pool, read at blockNumber */
export interface UniswapV4PoolState extends UniswapV4StaticPool {
  sqrtPriceX96: bigint
  tick: number
  /** tick rounded down to the tick spacing */
  activeTick: number
  liquidity: bigint
  /** the initialized ticks of the read tick table words, sorted, by word */
  ticks: Map<number, CLTick[]>
  /** the block each tick table word was read at, the word holds the tick changes of the logs up to it */
  wordBlocks?: Map<number, bigint>
  lpFee: number
  protocolFee: number
  /** the swap fee in 1/1_000_000 fractions, see uniswapV4SwapFee */
  swapFee: number
  blockNumber: bigint
}

const bitmapIndex = (tick: number, tickSpacing: number) =>
  Math.floor(tick / tickSpacing / 256)

const pairKey = ({ currency0, currency1 }: UniswapV4TokenPair) =>
  `${currency0}:${currency1}`

/** the Initialize scan of a currency pair, see getPoolsFromLogs */
interface InitializeScan {
  /** the block the scan of the pair reached, every block from the PoolManager deployment up to it is read */
  through: bigint
  /** the supported pools the logs told, by lowercase id */
  pools: Map<string, UniswapV4StaticPool>
}

/**
 * A Uniswap V4 provider. Every V4 pool lives in one PoolManager, the pools
 * are told by their id, and their state is read with the StateView lens at
 * one block. The pools are the ones without hooks at the default fee tiers
 * for the token pairs of a fetch, and their variants with the native
 * currency in place of the wrapped native token. With discoverPoolsByLogs
 * on, the PoolManager Initialize logs add the pools with hooks and with
 * other fees and tick spacings, the ones isUniswapV4PoolSupported accepts
 */
export abstract class UniswapV4BaseProvider extends LiquidityProvider {
  /** the existing pools, by lowercase id */
  pools: Map<string, UniswapV4PoolState> = new Map()
  /** the lowercase ids of the pools of each trade, see getTradeId */
  poolsByTrade: Map<string, string[]> = new Map()
  poolManager: Record<number, Address> = {}
  stateView: Record<number, Address> = {}
  /** the block each PoolManager was deployed at, by chain id, the Initialize scan starts there */
  initializeLogsFromBlock: Record<number, bigint> = {}
  /** the fee tiers of the pools without hooks that are read */
  feeTiers: UniswapV4FeeTier[] = UNISWAP_V4_DEFAULT_FEE_TIERS
  /**
   * Read the PoolManager Initialize logs to find the pools with hooks and
   * with other fees and tick spacings, see getPoolsFromLogs. Off by default:
   * the first scan of a token set reads every block since the PoolManager
   * deployment
   */
  discoverPoolsByLogs = false
  /** the blocks one Initialize log read covers at most */
  initializeLogsPageSize = 10_000n
  /** the Initialize log reads that run at once */
  initializeLogsConcurrency = 4
  /** the Initialize scans, by "currency0:currency1" */
  initializeScans: Map<string, InitializeScan> = new Map()

  constructor(
    chainId: ChainId,
    web3Client: PublicClient,
    poolManager: Record<number, Address>,
    stateView: Record<number, Address>,
    initializeLogsFromBlock: Record<number, bigint> = {},
    isTest = false,
  ) {
    super(chainId, web3Client, isTest)
    this.poolManager = poolManager
    this.stateView = stateView
    this.initializeLogsFromBlock = initializeLogsFromBlock
    if (!(chainId in this.poolManager) || !(chainId in this.stateView)) {
      throw new Error(
        `${this.getType()} cannot be instantiated for chainid ${chainId}, no poolManager or stateView`,
      )
    }
  }

  getPoolManager(): Address {
    return this.poolManager[this.chainId]!
  }

  getStateView(): Address {
    return this.stateView[this.chainId]!
  }

  /** the native currency as a tines token, the same one the native wrap bridge has */
  nativeToken(): RToken {
    const native = Native.onChain(this.chainId)
    return {
      address: '',
      name: native.name,
      symbol: native.symbol,
      chainId: this.chainId,
      decimals: native.decimals,
    }
  }

  /**
   * The sorted token pairs of the given tokens' combinations, and for every
   * pair with the wrapped native token, the same pair with the native
   * currency
   */
  currencyPairs(
    t0: Token,
    t1: Token,
    extraPairs?: [Token, Token][],
  ): UniswapV4TokenPair[] {
    const wnative = WNATIVE_ADDRESS[this.chainId]?.toLowerCase()
    const native = this.nativeToken()
    const unsorted: [RToken, RToken][] = []
    getCurrencyCombinations(this.chainId, t0, t1, extraPairs).forEach(
      ([a, b]) => {
        if (!a || !b || a.address.toLowerCase() === b.address.toLowerCase())
          return
        unsorted.push([a as RToken, b as RToken])
        if (a.address.toLowerCase() === wnative)
          unsorted.push([native, b as RToken])
        if (b.address.toLowerCase() === wnative)
          unsorted.push([a as RToken, native])
      },
    )
    const pairs = new Map<string, UniswapV4TokenPair>()
    unsorted.forEach(([a, b]) => {
      const currencyA = this.currencyOf(a)
      const currencyB = this.currencyOf(b)
      const pair =
        currencyA < currencyB
          ? { token0: a, token1: b, currency0: currencyA, currency1: currencyB }
          : { token0: b, token1: a, currency0: currencyB, currency1: currencyA }
      pairs.set(pairKey(pair), pair)
    })
    return Array.from(pairs.values())
  }

  /** The pools without hooks at the fee tiers for the pairs of currencyPairs */
  getStaticPools(
    t0: Token,
    t1: Token,
    extraPairs?: [Token, Token][],
  ): UniswapV4StaticPool[] {
    const pools = new Map<string, UniswapV4StaticPool>()
    this.currencyPairs(t0, t1, extraPairs).forEach((pair) => {
      const { token0, token1, currency0, currency1 } = pair
      this.feeTiers.forEach(({ fee, tickSpacing }) => {
        const key: UniswapV4PoolKey = {
          currency0,
          currency1,
          fee,
          tickSpacing,
          hooks: UNISWAP_V4_ZERO_HOOKS,
        }
        const id = computeUniswapV4PoolId(key)
        pools.set(id, { ...key, id, token0, token1 })
      })
    })
    return Array.from(pools.values())
  }

  /** the lowercase PoolKey currency of a tines token */
  currencyOf(token: RToken): Address {
    return token.address === ''
      ? UNISWAP_V4_NATIVE
      : (token.address.toLowerCase() as Address)
  }

  /** Adds the given pools to the pools the trade routes through */
  addTradePools(t0: Token, t1: Token, pools: { id: string }[]) {
    const tradeId = this.getTradeId(t0, t1)
    const known = this.poolsByTrade.get(tradeId) ?? []
    pools.forEach(({ id }) => {
      if (!known.includes(id)) known.push(id)
    })
    this.poolsByTrade.set(tradeId, known)
  }

  /**
   * The supported pools that the PoolManager Initialize logs tell for the
   * pairs of currencyPairs, up to the given block. One scan reads the logs of
   * every pair at once, filtered by their currencies, in pages of
   * initializeLogsPageSize blocks with initializeLogsConcurrency reads at
   * once. A pair's scan is kept with the block it reached, so a later call
   * reads only the blocks after it, and a pair new to the scan starts at the
   * PoolManager deployment. A failed page stops the scan, it goes on from
   * there at the next call
   */
  async getPoolsFromLogs(
    t0: Token,
    t1: Token,
    toBlock: bigint,
    extraPairs?: [Token, Token][],
  ): Promise<UniswapV4StaticPool[]> {
    const pairs = this.currencyPairs(t0, t1, extraPairs)
    if (pairs.length === 0) return []
    const deployBlock = this.initializeLogsFromBlock[this.chainId] ?? 0n
    const scanOf = (key: string) => {
      let scan = this.initializeScans.get(key)
      if (!scan) {
        scan = { through: deployBlock - 1n, pools: new Map() }
        this.initializeScans.set(key, scan)
      }
      return scan
    }
    const tokens = new Map<string, RToken>()
    let fromBlock = toBlock + 1n
    pairs.forEach((pair) => {
      tokens.set(pair.currency0, pair.token0)
      tokens.set(pair.currency1, pair.token1)
      const start = scanOf(pairKey(pair)).through + 1n
      if (start < fromBlock) fromBlock = start
    })
    if (fromBlock <= toBlock) {
      const { logs, reached } = await this.readInitializeLogs(
        Array.from(tokens.keys()) as Address[],
        fromBlock,
        toBlock,
      )
      const wanted = new Set(pairs.map(pairKey))
      logs.forEach((log) => {
        const pool = this.staticPoolOfLog(log.args, tokens)
        if (!pool) return
        const key = `${pool.currency0}:${pool.currency1}`
        if (wanted.has(key)) scanOf(key).pools.set(pool.id, pool)
      })
      pairs.forEach((pair) => {
        const scan = scanOf(pairKey(pair))
        if (reached > scan.through) scan.through = reached
      })
    }
    return pairs.flatMap((pair) =>
      Array.from(scanOf(pairKey(pair)).pools.values()),
    )
  }

  /**
   * Reads the Initialize logs of the pools of the given currencies from
   * fromBlock to toBlock in pages
   * @returns the logs of the pages read, and the end of the last page of the
   * unbroken run of read pages from fromBlock, fromBlock - 1 when the first
   * one failed
   */
  async readInitializeLogs(
    currencies: Address[],
    fromBlock: bigint,
    toBlock: bigint,
  ) {
    const pageSize = this.initializeLogsPageSize
    const pages: { from: bigint; to: bigint }[] = []
    for (let from = fromBlock; from <= toBlock; from += pageSize) {
      const to = from + pageSize - 1n
      pages.push({ from, to: to < toBlock ? to : toBlock })
    }
    const read = (page: { from: bigint; to: bigint }) =>
      this.client
        .getLogs({
          address: this.getPoolManager(),
          event: uniswapV4PoolManagerAbi_Initialize[0],
          args: { currency0: currencies, currency1: currencies },
          fromBlock: page.from,
          toBlock: page.to,
        })
        .catch(() => undefined)
    const results: Awaited<ReturnType<typeof read>>[] = pages.map(
      () => undefined,
    )
    let next = 0
    let failed = false
    // a failed page stops the workers, the pages in flight still land
    const worker = async () => {
      while (!failed && next < pages.length) {
        const i = next++
        results[i] = await read(pages[i]!)
        if (results[i] === undefined) failed = true
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(this.initializeLogsConcurrency, pages.length) },
        worker,
      ),
    )
    let reached = fromBlock - 1n
    for (let i = 0; i < pages.length && results[i] !== undefined; i++)
      reached = pages[i]!.to
    if (failed) {
      console.warn(
        `${this.getLogPrefix()} - Initialize logs read failed after block ${reached}, the scan goes on from there at the next fetch`,
      )
    }
    return { logs: results.flatMap((logs) => logs ?? []), reached }
  }

  /**
   * The pool an Initialize log tells, undefined when isUniswapV4PoolSupported
   * rejects it, when a currency is not one of the given tokens, or when the
   * log's id is not the id of its PoolKey
   */
  staticPoolOfLog(
    args: {
      id?: Hex | undefined
      currency0?: Address | undefined
      currency1?: Address | undefined
      fee?: number | undefined
      tickSpacing?: number | undefined
      hooks?: Address | undefined
    },
    tokens: Map<string, RToken>,
  ): UniswapV4StaticPool | undefined {
    const { id, currency0, currency1, fee, tickSpacing, hooks } = args
    if (
      id === undefined ||
      currency0 === undefined ||
      currency1 === undefined ||
      fee === undefined ||
      tickSpacing === undefined ||
      hooks === undefined
    )
      return undefined
    const key: UniswapV4PoolKey = {
      currency0: currency0.toLowerCase() as Address,
      currency1: currency1.toLowerCase() as Address,
      fee,
      tickSpacing,
      hooks: hooks.toLowerCase() as Address,
    }
    const token0 = tokens.get(key.currency0)
    const token1 = tokens.get(key.currency1)
    if (!token0 || !token1 || !isUniswapV4PoolSupported(key)) return undefined
    const poolId = computeUniswapV4PoolId(key)
    if (poolId !== id.toLowerCase()) return undefined
    return { ...key, id: poolId, token0, token1 }
  }

  /**
   * The pools a fetch reads, out of the ones it found: all of them. A
   * provider that keeps pools between fetches overrides it
   */
  selectPools(
    pools: UniswapV4StaticPool[],
    _options?: DataFetcherOptions,
  ): UniswapV4StaticPool[] {
    return pools
  }

  /** Called for a pool id that has no pool at the read block, nothing here */
  onMissingPool(_pool: UniswapV4StaticPool) {}

  /**
   * Reads the pools of the token pairs at one block, the given one or the
   * latest: the static pools, and with discoverPoolsByLogs the pools the
   * Initialize logs tell up to that block, the ones selectPools picks. A
   * pool that is not initialized is skipped, and so is a pool with a failed
   * word or tick read, its ticks would be incomplete
   */
  async fetchPoolsForToken(
    t0: Token,
    t1: Token,
    excludePools?: Set<string>,
    options?: DataFetcherOptions,
  ): Promise<void> {
    // every read is pinned to one block, the state of one pool must not mix blocks
    const blockNumber =
      options?.blockNumber ??
      (await this.client.getBlockNumber().catch(() => undefined))
    if (blockNumber === undefined) return
    const candidates = new Map<string, UniswapV4StaticPool>()
    this.getStaticPools(t0, t1, options?.fetchPoolsExtraPairs).forEach((p) =>
      candidates.set(p.id, p),
    )
    if (this.discoverPoolsByLogs) {
      const found = await this.getPoolsFromLogs(
        t0,
        t1,
        blockNumber,
        options?.fetchPoolsExtraPairs,
      )
      found.forEach((p) => {
        if (!candidates.has(p.id)) candidates.set(p.id, p)
      })
    }
    let staticPools = Array.from(candidates.values())
    if (excludePools)
      staticPools = staticPools.filter((p) => !excludePools.has(p.id))
    this.addTradePools(t0, t1, staticPools)
    staticPools = this.selectPools(staticPools, options)
    if (staticPools.length === 0) return

    const stateView = this.getStateView()
    const multicallAddress = this.client.chain?.contracts?.multicall3
      ?.address as Address

    const slot0 = await this.client
      .multicall({
        multicallAddress,
        allowFailure: true,
        blockNumber,
        contracts: staticPools.map(
          (pool) =>
            ({
              address: stateView,
              chainId: this.chainId,
              abi: uniswapV4StateViewAbi_getSlot0,
              functionName: 'getSlot0',
              args: [pool.id],
            }) as const,
        ),
      })
      .catch((e) => {
        console.warn(
          `${this.getLogPrefix()} - INIT: slot0 multicall failed, message: ${
            e.message
          }`,
        )
        return undefined
      })
    if (slot0 === undefined) return

    const existing: {
      pool: UniswapV4StaticPool
      sqrtPriceX96: bigint
      tick: number
      activeTick: number
      lpFee: number
      protocolFee: number
    }[] = []
    staticPools.forEach((pool, i) => {
      // a failed read tells nothing about the pool
      const result = slot0[i]?.result
      if (!result) return
      const [sqrtPriceX96, tick, protocolFee, lpFee] = result
      // a pool that is not initialized has a zero price
      if (!sqrtPriceX96 || typeof tick !== 'number') {
        this.onMissingPool(pool)
        return
      }
      existing.push({
        pool,
        sqrtPriceX96,
        tick,
        activeTick: Math.floor(tick / pool.tickSpacing) * pool.tickSpacing,
        lpFee,
        protocolFee,
      })
    })
    if (existing.length === 0) return

    const [liquidities, words] = await Promise.all([
      this.client
        .multicall({
          multicallAddress,
          allowFailure: true,
          blockNumber,
          contracts: existing.map(
            ({ pool }) =>
              ({
                address: stateView,
                chainId: this.chainId,
                abi: uniswapV4StateViewAbi_getLiquidity,
                functionName: 'getLiquidity',
                args: [pool.id],
              }) as const,
          ),
        })
        .catch((e) => {
          console.warn(
            `${this.getLogPrefix()} - INIT: liquidity multicall failed, message: ${
              e.message
            }`,
          )
          return undefined
        }),
      this.readTickWords(
        existing.map(({ pool, activeTick }) => ({
          id: pool.id,
          tickSpacing: pool.tickSpacing,
          words: this.windowWords(activeTick, pool.tickSpacing),
        })),
        blockNumber,
      ),
    ])
    if (liquidities === undefined || words === undefined) return

    existing.forEach((state, i) => {
      const liquidity = liquidities[i]?.result
      const ticks = words[i]
      if (liquidity === undefined || ticks === undefined) return
      const { pool } = state
      this.pools.set(pool.id, {
        ...pool,
        sqrtPriceX96: state.sqrtPriceX96,
        tick: state.tick,
        activeTick: state.activeTick,
        liquidity,
        ticks,
        wordBlocks: new Map(
          [...ticks.keys()].map((word) => [word, blockNumber]),
        ),
        lpFee: state.lpFee,
        protocolFee: state.protocolFee,
        swapFee: uniswapV4SwapFee(state.lpFee, state.protocolFee),
        blockNumber,
      })
    })
  }

  /** The tick table words around the active tick a pool keeps, NUMBER_OF_SURROUNDING_TICKS to each side */
  windowWords(activeTick: number, tickSpacing: number): number[] {
    const min = bitmapIndex(
      activeTick - NUMBER_OF_SURROUNDING_TICKS,
      tickSpacing,
    )
    const max = bitmapIndex(
      activeTick + NUMBER_OF_SURROUNDING_TICKS,
      tickSpacing,
    )
    return Array.from({ length: max - min + 1 }, (_, j) => min + j)
  }

  /**
   * Reads the initialized ticks of the given words of the given pools at the
   * block. V4 has no tick lens: the bitmap words tell the initialized ticks,
   * then the liquidity of each one is read
   * @returns the sorted ticks of each pool by word, undefined for a pool
   * with a failed read, its words would be incomplete; undefined when a read
   * failed as a whole
   */
  async readTickWords(
    pools: { id: Hex; tickSpacing: number; words: number[] }[],
    blockNumber: bigint,
  ): Promise<(Map<number, CLTick[]> | undefined)[] | undefined> {
    const stateView = this.getStateView()
    const multicallAddress = this.client.chain?.contracts?.multicall3
      ?.address as Address
    const words = pools.flatMap((pool, index) =>
      pool.words.map((word) => ({ index, id: pool.id, word })),
    )
    // viem still sends an empty aggregate3 call for an empty list
    if (words.length === 0) return pools.map(() => new Map())
    const bitmaps = await this.client
      .multicall({
        multicallAddress,
        allowFailure: true,
        blockNumber,
        contracts: words.map(
          ({ id, word }) =>
            ({
              address: stateView,
              chainId: this.chainId,
              abi: uniswapV4StateViewAbi_getTickBitmap,
              functionName: 'getTickBitmap',
              args: [id, word],
            }) as const,
        ),
      })
      .catch((e) => {
        console.warn(
          `${this.getLogPrefix()} - tick bitmap multicall failed, message: ${
            e.message
          }`,
        )
        return undefined
      })
    if (bitmaps === undefined) return undefined

    const failed = pools.map(() => false)
    const result = pools.map(() => new Map<number, CLTick[]>())
    const tickReads: { index: number; word: number; tick: number }[] = []
    bitmaps.forEach((r, i) => {
      const { index, word } = words[i]!
      const bitmap = r.result
      if (bitmap === undefined) {
        failed[index] = true
        return
      }
      result[index]!.set(word, [])
      const tickSpacing = pools[index]!.tickSpacing
      for (let bit = 0; bit < 256; bit++) {
        if ((bitmap >> BigInt(bit)) & 1n)
          tickReads.push({
            index,
            word,
            tick: (word * 256 + bit) * tickSpacing,
          })
      }
    })

    const ticks =
      tickReads.length > 0
        ? await this.client
            .multicall({
              multicallAddress,
              allowFailure: true,
              blockNumber,
              contracts: tickReads.map(
                ({ index, tick }) =>
                  ({
                    address: stateView,
                    chainId: this.chainId,
                    abi: uniswapV4StateViewAbi_getTickLiquidity,
                    functionName: 'getTickLiquidity',
                    args: [pools[index]!.id, tick],
                  }) as const,
              ),
            })
            .catch((e) => {
              console.warn(
                `${this.getLogPrefix()} - ticks multicall failed, message: ${
                  e.message
                }`,
              )
              return undefined
            })
        : []
    if (ticks === undefined) return undefined
    // the ticks of a word come in bit order, so each word is sorted
    ticks.forEach((r, i) => {
      const { index, word, tick } = tickReads[i]!
      const liquidityNet = r.result?.[1]
      if (liquidityNet === undefined) {
        failed[index] = true
        return
      }
      result[index]!.get(word)!.push({ index: tick, DLiquidity: liquidityNet })
    })
    return result.map((words, i) => (failed[i] ? undefined : words))
  }

  /**
   * The ticks tines takes for a pool: the ones of the unbroken run of read
   * words around the active tick's word, between the bounds of that run, no
   * liquidity change is taken past them. Undefined when the active tick's
   * word is not read, a swap moved the price past the read words
   */
  tickList(state: UniswapV4PoolState): CLTick[] | undefined {
    const tickSpacing = state.tickSpacing
    const current = bitmapIndex(state.activeTick, tickSpacing)
    if (!state.ticks.has(current)) return undefined
    let min = current
    while (state.ticks.has(min - 1)) min--
    let max = current
    while (state.ticks.has(max + 1)) max++
    const ticks: CLTick[] = [
      { index: min * tickSpacing * 256 - tickSpacing, DLiquidity: 0n },
    ]
    for (let word = min; word <= max; word++)
      ticks.push(...state.ticks.get(word)!)
    ticks.push({ index: (max + 1) * tickSpacing * 256, DLiquidity: 0n })
    return ticks
  }

  /**
   * Builds the tines pool and its pool code of a cached pool, undefined while
   * the ticks around its price are not read, see tickList
   */
  poolCodeOf(state: UniswapV4PoolState): PoolCode | undefined {
    const ticks = this.tickList(state)
    if (!ticks) return undefined
    const pool = new UniV4Pool(
      state.id,
      this.getPoolManager(),
      state.token0,
      state.token1,
      state.swapFee / 1_000_000,
      state.hooks,
      state.activeTick,
      state.liquidity,
      state.sqrtPriceX96,
      ticks,
      undefined,
      state.tick,
    )
    return new UniV4PoolCode(
      pool,
      {
        currency0: state.currency0,
        currency1: state.currency1,
        fee: state.fee,
        tickSpacing: state.tickSpacing,
        hooks: state.hooks,
      },
      this.getType(),
      this.getPoolProviderName(),
    )
  }

  getCurrentPoolList(t0: Token, t1: Token): PoolCode[] {
    const ids = this.poolsByTrade.get(this.getTradeId(t0, t1)) ?? []
    const poolCodes: PoolCode[] = []
    ids.forEach((id) => {
      const state = this.pools.get(id)
      const poolCode = state ? this.poolCodeOf(state) : undefined
      if (poolCode) poolCodes.push(poolCode)
    })
    return poolCodes
  }

  // the pools are read on fetch, there is nothing to watch
  startFetchPoolsData() {}

  stopFetchPoolsData() {}
}
