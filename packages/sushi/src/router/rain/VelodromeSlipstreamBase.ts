import {
  Address,
  Hex,
  Log,
  PublicClient,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiItem,
  parseAbiParameters,
  parseEventLogs,
} from 'viem'
import { ChainId } from '../../chain/index.js'
import { Token } from '../../currency/index.js'
import { getCurrencyCombinations } from '../get-currency-combinations.js'
import {
  PoolFilter,
  StaticPoolUniV3,
} from '../liquidity-providers/UniswapV3Base.js'
import { RainDataFetcherOptions } from './RainDataFetcher.js'
import {
  RainV3Pool,
  UniV3EventsAbi,
  UniswapV3BaseProvider,
} from './UniswapV3Base.js'

export const ZERO_FEE_INDICATOR = 420

/**
 * Classification of a pool's base fee on the swap fee module
 * - Default: no custom fee set, the factory's tickSpacingToFee applies
 * - Dynamic: a custom (per pool) base fee is set on the module
 * - Zero: the module holds ZERO_FEE_INDICATOR, the pool charges no fee
 */
export enum FeeType {
  Default = 0,
  Dynamic = 1,
  Zero = 2,
}

/**
 * Per pool fee settings as held by the swap fee module.
 * The plain CustomSwapFeeModule only has baseFee (its customFee mapping),
 * the DynamicSwapFeeModule versions add the rest, see
 * VelodromeSlipstreamDynamicFeeBase.ts
 */
export interface SlipstreamFeeConfig {
  baseFee: number
  feeCap: number
  scalingFactor: bigint
  initialFeeEnabled: boolean
  initialFee: number
}

export const DEFAULT_FEE_CONFIG: SlipstreamFeeConfig = {
  baseFee: 0,
  feeCap: 0,
  scalingFactor: 0n,
  initialFeeEnabled: false,
  initialFee: 0,
}

export interface StaticSlipstreamPool extends StaticPoolUniV3 {
  tickSpacing: number
  feeType: FeeType
  feeConfig: SlipstreamFeeConfig
}

export interface SlipstreamPool extends RainV3Pool {
  feeType: FeeType
  feeConfig: SlipstreamFeeConfig
}

export const feeAbi = [
  {
    inputs: [],
    name: 'fee',
    outputs: [{ internalType: 'uint24', name: '', type: 'uint24' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

const slot0Abi = [
  {
    inputs: [],
    name: 'slot0',
    outputs: [
      { internalType: 'uint160', name: 'sqrtPriceX96', type: 'uint160' },
      { internalType: 'int24', name: 'tick', type: 'int24' },
      { internalType: 'uint16', name: 'observationIndex', type: 'uint16' },
      {
        internalType: 'uint16',
        name: 'observationCardinality',
        type: 'uint16',
      },
      {
        internalType: 'uint16',
        name: 'observationCardinalityNext',
        type: 'uint16',
      },
      { internalType: 'bool', name: 'unlocked', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const customFeeAbi = [
  {
    inputs: [{ internalType: 'address', name: '_pool', type: 'address' }],
    name: 'customFee',
    outputs: [{ internalType: 'uint24', name: '', type: 'uint24' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const SlipstreamEventsAbi = [
  ...UniV3EventsAbi.slice(0, -1), // univ3 shared events except PoolCreated
  parseAbiItem(
    'event PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)',
  ),
  parseAbiItem(
    'event TickSpacingEnabled(int24 indexed tickSpacing, uint24 indexed fee)',
  ),
  parseAbiItem('event CustomFeeSet(address indexed pool, uint24 indexed fee)'),
  // pre nov 2024 name of CustomFeeSet, still emitted by older deployed
  // custom fee modules (eg aerodrome factory 0x9592... on base)
  parseAbiItem('event SetCustomFee(address indexed pool, uint24 indexed fee)'),
  parseAbiItem(
    'event SwapFeeModuleChanged(address indexed oldFeeModule, address indexed newFeeModule)',
  ),
]

/**
 * Base provider for slipstream CL factories whose swapFeeModule is the plain
 * CustomSwapFeeModule: a pool's fee is either its customFee on the module,
 * zero (ZERO_FEE_INDICATOR) or the factory's tickSpacingToFee. All of these
 * only change through events (CustomFeeSet, TickSpacingEnabled,
 * SwapFeeModuleChanged), so no per round rpc reads are needed.
 *
 * Factories whose module is a DynamicSwapFeeModule need the child providers
 * in VelodromeSlipstreamDynamicFeeBase.ts
 */
export abstract class VelodromeSlipstreamBaseProvider extends UniswapV3BaseProvider {
  readonly BASE_FEE = 100
  DEFAULT_TICK_SPACINGS = [1, 50, 100, 200, 2000] as const
  tickSpacings: number[] = [...this.DEFAULT_TICK_SPACINGS]

  shouldResetFees = false
  feeSpacingMap: Record<number, number> = {} // fee to tick spacing map
  spacingFeeMap: Record<number, number> = {} // tick spacing to fee map

  // poolImplementation and swapFeeModule addresses, fetched at init() from
  // factory since they can change over time and are not contract constants
  poolImplementation: Record<number, Address> = {}
  swapFeeModule: Record<number, Address> = {}

  override eventsAbi = SlipstreamEventsAbi as any

  constructor(
    chainId: ChainId,
    web3Client: PublicClient,
    factory: Record<number, Address>,
    tickLens: Record<number, Address>,
    isTest = false,
  ) {
    super(
      chainId,
      web3Client,
      factory,
      { [chainId]: `0x${'0'.repeat(64)}` }, // dummy, since slipstream has no initCodeHash
      tickLens,
      isTest,
    )
  }

  override async init(blockNumber?: bigint) {
    if (!this.initialized) {
      if (!this.poolImplementation[this.chainId]) {
        const poolImplementation = await this.client
          .readContract({
            address: this.factory[this.chainId as keyof typeof this.factory]!,
            blockNumber,
            abi: [
              {
                inputs: [],
                name: 'poolImplementation',
                outputs: [
                  { internalType: 'address', name: '', type: 'address' },
                ],
                stateMutability: 'view',
                type: 'function',
              },
            ] as const,
            functionName: 'poolImplementation',
          })
          .catch((e) => {
            console.warn(
              `${this.getLogPrefix()} - INIT: failed to get poolImplementation address, message: ${
                e.message
              }`,
            )
            return undefined
          })
        if (!poolImplementation) return
        this.poolImplementation[this.chainId] = poolImplementation
      }

      if (!this.swapFeeModule[this.chainId]) {
        const swapFeeModule = await this.client
          .readContract({
            address: this.factory[this.chainId as keyof typeof this.factory]!,
            blockNumber,
            abi: [
              {
                inputs: [],
                name: 'swapFeeModule',
                outputs: [
                  { internalType: 'address', name: '', type: 'address' },
                ],
                stateMutability: 'view',
                type: 'function',
              },
            ] as const,
            functionName: 'swapFeeModule',
          })
          .catch((e) => {
            console.warn(
              `${this.getLogPrefix()} - INIT: failed to get swapFeeModule address, message: ${
                e.message
              }`,
            )
            return undefined
          })
        if (!swapFeeModule) return
        this.swapFeeModule[this.chainId] = swapFeeModule
      }

      if (!this.tickSpacings) {
        const tickSpacings = await this.client
          .readContract({
            address: this.factory[this.chainId as keyof typeof this.factory]!,
            blockNumber,
            abi: [
              {
                inputs: [],
                name: 'tickSpacings',
                outputs: [
                  { internalType: 'int24[]', name: '', type: 'int24[]' },
                ],
                stateMutability: 'view',
                type: 'function',
              },
            ],
            functionName: 'tickSpacings',
          })
          .catch((e) => {
            console.warn(
              `${this.getLogPrefix()} - INIT: failed to get tickSpacings, message: ${
                e.message
              }`,
            )
            return undefined
          })
        this.tickSpacings = (tickSpacings ??
          this.DEFAULT_TICK_SPACINGS) as number[]
      }

      if (!Object.values(this.feeSpacingMap).length) {
        const fees = await this.client
          .multicall({
            multicallAddress:
              this.client.chain?.contracts?.multicall3?.address!,
            allowFailure: true,
            blockNumber,
            contracts: this.tickSpacings.map((spacing) => ({
              address: this.factory[this.chainId as keyof typeof this.factory]!,
              chainId: this.chainId,
              abi: [
                {
                  inputs: [{ internalType: 'int24', name: '', type: 'int24' }],
                  name: 'tickSpacingToFee',
                  outputs: [
                    { internalType: 'uint24', name: '', type: 'uint24' },
                  ],
                  stateMutability: 'view',
                  type: 'function',
                },
              ] as const,
              functionName: 'tickSpacingToFee',
              args: [spacing],
            })),
          })
          .catch((e) => {
            console.warn(
              `${this.getLogPrefix()} - INIT: multicall failed to get tickSpacingToFee, message: ${
                e.message
              }`,
            )
            return undefined
          })
        if (!fees) return
        for (let i = 0; i < this.tickSpacings.length; i++) {
          const fee = fees?.[i]?.result
          const tickSpacing = this.tickSpacings[i]
          if (typeof fee === 'number' && typeof tickSpacing === 'number') {
            this.feeSpacingMap[fee] = tickSpacing
            this.spacingFeeMap[tickSpacing] = fee
          }
        }
      }
      if (!(await this.initFeeModule(blockNumber))) return
      this.initialized = true
    }
  }

  /**
   * Hook for child providers to read extra state from the swap fee module
   * at init (and again after a SwapFeeModuleChanged). Returns false on
   * failure, which aborts init so it gets retried
   */
  protected async initFeeModule(blockNumber?: bigint): Promise<boolean> {
    // this provider models the plain CustomSwapFeeModule, a
    // DynamicSwapFeeModule also answers customFee() (with its base fee
    // only) so a wrong module version would go unnoticed, probe for it
    const secondsAgo = await this.client
      .readContract({
        address: this.swapFeeModule[this.chainId]!,
        blockNumber,
        abi: [
          {
            inputs: [],
            name: 'secondsAgo',
            outputs: [{ internalType: 'uint32', name: '', type: 'uint32' }],
            stateMutability: 'view',
            type: 'function',
          },
        ] as const,
        functionName: 'secondsAgo',
      })
      .catch(() => undefined)
    if (typeof secondsAgo === 'number') {
      console.warn(
        `${this.getLogPrefix()} - INIT: swapFeeModule ${
          this.swapFeeModule[this.chainId]
        } looks like a DynamicSwapFeeModule but this provider models the CustomSwapFeeModule, pool fees may be wrong`,
      )
    }
    return true
  }

  /**
   * Reads the fee settings of the given pools from the swap fee module.
   * Returns undefined when the whole read failed (rpc problem), otherwise
   * one entry per pool, undefined for the pools whose read failed
   */
  protected async readFeeConfigs(
    pools: { address: Address }[],
    blockNumber?: bigint,
  ): Promise<(SlipstreamFeeConfig | undefined)[] | undefined> {
    if (!pools.length) return []
    const results = await this.client
      .multicall({
        multicallAddress: this.client.chain?.contracts?.multicall3?.address!,
        allowFailure: true,
        blockNumber,
        contracts: pools.map((pool) => ({
          address: this.swapFeeModule[this.chainId]!,
          chainId: this.chainId,
          abi: customFeeAbi,
          functionName: 'customFee',
          args: [pool.address],
        })),
      })
      .catch((e) => {
        console.warn(
          `${this.getLogPrefix()} - multicall failed to get customFee, message: ${
            e.message
          }`,
        )
        return undefined
      })
    if (!results) return undefined
    return results.map((res) => {
      const baseFee = res?.result
      if (typeof baseFee !== 'number') return undefined
      return { ...DEFAULT_FEE_CONFIG, baseFee }
    })
  }

  /**
   * Whether the pool's fee depends on state that changes without any event
   * (eg the dynamic fee module's tick vs twap tick term), such pools get
   * their fee() re-read on every update round. Never the case for the
   * plain custom fee module
   */
  protected isVolatile(_pool: { feeConfig: SlipstreamFeeConfig }): boolean {
    return false
  }

  protected classifyBaseFee(baseFee: number): FeeType {
    if (baseFee === ZERO_FEE_INDICATOR) return FeeType.Zero
    if (baseFee === 0) return FeeType.Default
    return FeeType.Dynamic
  }

  protected applyFeeConfig(
    pool: { feeType: FeeType; feeConfig: SlipstreamFeeConfig },
    config: SlipstreamFeeConfig,
  ) {
    pool.feeConfig = config
    pool.feeType = this.classifyBaseFee(config.baseFee)
  }

  /**
   * Resolves the fee of a non volatile pool from its fee settings, ie the
   * part of the fee that only changes through events
   */
  protected resolveStaticFee(pool: {
    tickSpacing: number
    feeType: FeeType
    feeConfig: SlipstreamFeeConfig
  }): number | undefined {
    if (pool.feeType === FeeType.Zero) return 0
    if (pool.feeType === FeeType.Dynamic) return pool.feeConfig.baseFee
    return this.spacingFeeMap[pool.tickSpacing]
  }

  /**
   * Re-resolves the fee of a cached pool from its fee settings, no-op for
   * volatile pools since those get their fee re-read from chain
   */
  protected refreshStaticFee(pool: SlipstreamPool) {
    if (this.isVolatile(pool)) return
    const fee = this.resolveStaticFee(pool)
    if (typeof fee === 'number') pool.fee = fee
  }

  /**
   * Reads the current fee() of the given pools, returns undefined when the
   * whole read failed, otherwise one entry per pool
   */
  protected async readPoolFees(
    pools: { address: Address }[],
    blockNumber?: bigint,
  ): Promise<(number | undefined)[] | undefined> {
    if (!pools.length) return []
    const results = await this.client
      .multicall({
        multicallAddress: this.client.chain?.contracts?.multicall3?.address!,
        allowFailure: true,
        blockNumber,
        contracts: pools.map(
          (pool) =>
            ({
              address: pool.address,
              chainId: this.chainId,
              abi: feeAbi,
              functionName: 'fee',
            }) as const,
        ),
      })
      .catch((e) => {
        console.warn(
          `${this.getLogPrefix()} - multicall failed to get pool fees, message: ${
            e.message
          }`,
        )
        return undefined
      })
    if (!results) return undefined
    return results.map((res) => {
      const fee = res?.result
      return typeof fee === 'number' ? fee : undefined
    })
  }

  override async fetchPoolData(
    t0: Token,
    t1: Token,
    excludePools?: Set<string> | PoolFilter,
    options?: RainDataFetcherOptions,
  ): Promise<SlipstreamPool[]> {
    await this.init(options?.blockNumber)

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
      staticPools = this.filterCachedPools(
        staticPools,
      ) as StaticSlipstreamPool[]
    }
    if (staticPools.length === 0) return []

    // the pools state (slot0) and their fee settings on the swap fee module
    // are independent reads, so they go out together. the fee settings of
    // a non existent pool come back as zeros and are simply not used
    const [slot0, feeConfigs] = await Promise.all([
      this.client
        .multicall({
          multicallAddress: this.client.chain?.contracts?.multicall3?.address!,
          allowFailure: true,
          blockNumber: options?.blockNumber,
          contracts: staticPools.map((pool) => ({
            address: pool.address,
            chainId: this.chainId,
            abi: slot0Abi,
            functionName: 'slot0',
          })),
        })
        .catch((e) => {
          console.warn(
            `${this.getLogPrefix()} - INIT: multicall failed, message: ${
              e.message
            }`,
          )
          return undefined
        }),
      this.readFeeConfigs(staticPools, options?.blockNumber),
    ])
    // a failure of the whole multicall is an rpc problem, not proof that
    // any pool is missing, so dont count null strikes, just retry later
    if (!slot0) return []

    // keep only the pools that exist, null strike the rest
    const existing: [StaticSlipstreamPool, bigint, number, number][] = []
    staticPools.forEach((pool, i) => {
      const poolAddress = pool.address.toLowerCase()
      if (!slot0[i]) {
        this.handleNullPool(poolAddress)
        return
      }
      const sqrtPriceX96 = slot0[i]!.result?.[0] // price
      const tick = slot0[i]!.result?.[1] // tick
      if (!sqrtPriceX96 || sqrtPriceX96 === 0n || typeof tick !== 'number') {
        this.handleNullPool(poolAddress)
        return
      }
      existing.push([pool, sqrtPriceX96, tick, i])
    })
    if (!existing.length) return []

    // the pools exist (slot0 succeeded), only their fees could not be
    // resolved, so skip them for this round without a null strike
    if (!feeConfigs) return []
    existing.forEach(([pool, , , i]) => {
      const config = feeConfigs[i]
      if (config) this.applyFeeConfig(pool, config)
    })
    const resolved = existing.filter(([, , , i]) => feeConfigs[i] !== undefined)

    // pools with a volatile fee need their current fee() read from chain,
    // keyed by address since index based consumption would misalign as
    // soon as one pool gets skipped
    const volatilePools = resolved
      .map(([pool]) => pool)
      .filter((pool) => this.isVolatile(pool))
    const volatileFees = new Map<string, number>()
    if (volatilePools.length) {
      const fees = await this.readPoolFees(volatilePools, options?.blockNumber)
      volatilePools.forEach((pool, i) => {
        const fee = fees?.[i]
        if (typeof fee === 'number')
          volatileFees.set(pool.address.toLowerCase(), fee)
      })
    }

    const existingPools: SlipstreamPool[] = []
    resolved.forEach(([pool, sqrtPriceX96, tick]) => {
      const poolAddress = pool.address.toLowerCase()
      const activeTick = Math.floor(tick / pool.tickSpacing) * pool.tickSpacing
      if (typeof activeTick !== 'number') {
        this.handleNullPool(poolAddress)
        return
      }
      const fee = this.isVolatile(pool)
        ? volatileFees.get(poolAddress)
        : this.resolveStaticFee(pool)
      if (typeof fee !== 'number') return

      existingPools.push({
        ...pool,
        fee,
        sqrtPriceX96,
        activeTick,
        ticks: new Map(),
        reserve0: 0n,
        reserve1: 0n,
        liquidity: 0n,
        blockNumber: options?.blockNumber ?? 0n,
        feeType: pool.feeType,
        feeConfig: pool.feeConfig,
        tick,
      })
    })

    return existingPools
  }

  override handleFactoryEvents(log: Log): boolean {
    const logAddress = log.address.toLowerCase()
    const factory =
      this.factory[this.chainId as keyof typeof this.factory]!.toLowerCase()
    const swapFeeModule =
      this.swapFeeModule[
        this.chainId as keyof typeof this.swapFeeModule
      ]!.toLowerCase()
    if (logAddress === factory || logAddress === swapFeeModule) {
      try {
        const event = parseEventLogs({
          logs: [log],
          abi: this.eventsAbi as typeof SlipstreamEventsAbi,
        })[0]!
        switch (event.eventName) {
          case 'PoolCreated': {
            return this.nullPools.delete(event.args.pool.toLowerCase())
          }
          case 'TickSpacingEnabled': {
            // new tick spacing enabled
            if (!this.tickSpacings.includes(event.args.tickSpacing)) {
              this.tickSpacings.push(event.args.tickSpacing)
            }
            this.feeSpacingMap[event.args.fee] = event.args.tickSpacing
            // spacingFeeMap is the map that fee resolution reads, without
            // this entry every pool of the new spacing gets a void fee
            this.spacingFeeMap[event.args.tickSpacing] = event.args.fee
            break
          }
          case 'CustomFeeSet':
          case 'SetCustomFee': {
            // pool base fee update
            const pool = this.pools.get(
              event.args.pool.toLowerCase(),
            ) as SlipstreamPool
            if (pool && log.blockNumber! >= pool.blockNumber) {
              pool.blockNumber = log.blockNumber!
              this.applyFeeConfig(pool, {
                ...pool.feeConfig,
                baseFee: event.args.fee,
              })
              this.refreshStaticFee(pool)
            }
            break
          }
          case 'SwapFeeModuleChanged': {
            // factory swapFeeModule address changed
            if (
              this.swapFeeModule[this.chainId]?.toLowerCase() !==
              event.args.newFeeModule.toLowerCase()
            ) {
              // we need to reset the cached pools fees as they might
              // have wrong fees after swapFeeModule address is changed
              // PS: this event is very rare
              this.swapFeeModule[this.chainId] = event.args.newFeeModule
              this.shouldResetFees = true
            }
            break
          }
          default: {
            this.otherFactoryEventCases(log, event)
          }
        }
      } catch {}
    }
    return false
  }

  // for child providers that have other factory/fee module events to handle
  protected otherFactoryEventCases(_log: Log, _event: any) {}

  override async afterProcessLog(untilBlock: bigint) {
    const shouldResetFees = this.shouldResetFees
    this.shouldResetFees = false
    const pools = Array.from(this.pools.values()) as SlipstreamPool[]

    await Promise.allSettled([
      // base after log process
      super.afterProcessLog(untilBlock),
      (async () => {
        if (shouldResetFees) {
          // swap fee module changed, re-read the module state and every
          // pool's fee settings, both only need the new module address
          const [moduleOk, configs] = await Promise.all([
            this.initFeeModule(untilBlock),
            this.readFeeConfigs(pools, untilBlock),
          ])
          if (moduleOk && configs) {
            pools.forEach((pool, i) => {
              const config = configs[i]
              if (!config) return
              this.applyFeeConfig(pool, config)
              this.refreshStaticFee(pool)
            })
          } else {
            // if failed, we'll try again on next update
            this.shouldResetFees = true
          }
        }
        // volatile pools get their fee re-read every round, on failure
        // they keep their previous fee until the next round
        const volatilePools = pools.filter((pool) => this.isVolatile(pool))
        const fees = await this.readPoolFees(volatilePools, untilBlock)
        volatilePools.forEach((pool, i) => {
          const fee = fees?.[i]
          if (typeof fee === 'number') pool.fee = fee
        })
      })(),
    ])
  }

  override getStaticPools(t1: Token, t2: Token): StaticSlipstreamPool[] {
    const allCombinations = getCurrencyCombinations(this.chainId, t1, t2)
    const currencyCombinations: [Token, Token, number][] = []
    allCombinations.forEach(([currencyA, currencyB]) => {
      if (currencyA && currencyB) {
        const tokenA = currencyA.wrapped
        const tokenB = currencyB.wrapped
        if (tokenA.equals(tokenB)) return
        const tokens = tokenA.sortsBefore(tokenB)
          ? [tokenA, tokenB]
          : [tokenB, tokenA]
        currencyCombinations.push(
          ...this.tickSpacings.map(
            (t) => [...tokens, t] as [Token, Token, number],
          ),
        )
      }
    })
    return currencyCombinations.map(([currencyA, currencyB, tickSpacing]) => ({
      address: this.getSlipstreamPoolAddress(
        this.factory[this.chainId as keyof typeof this.factory]!,
        currencyA.wrapped,
        currencyB.wrapped,
        tickSpacing,
      ),
      token0: currencyA,
      token1: currencyB,
      fee: this.BASE_FEE,
      tickSpacing,
      feeType: FeeType.Default,
      feeConfig: { ...DEFAULT_FEE_CONFIG },
    }))
  }

  // slipstream doesnt have the fee/ticks setup the same way univ3 has
  override async ensureFeeAndTicks(): Promise<boolean> {
    return true
  }

  getSlipstreamPoolAddress(
    factory: Address,
    tokenA: Token,
    tokenB: Token,
    tickSpacing: number,
  ): Address {
    const [token0, token1] = tokenA.sortsBefore(tokenB)
      ? [tokenA, tokenB]
      : [tokenB, tokenA]
    const constructorArgumentsEncoded = encodeAbiParameters(
      parseAbiParameters('address, address, int24'),
      [token0.address, token1.address, tickSpacing],
    )
    const initCode =
      `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${this.poolImplementation[
        this.chainId as keyof typeof this.poolImplementation
      ]!.replace('0x', '')}5af43d82803e903d91602b57fd5bf3` as Hex
    const initCodeHash = keccak256(initCode)

    const create2Inputs = [
      '0xff',
      factory,
      // salt
      keccak256(constructorArgumentsEncoded),
      // init code hash
      initCodeHash,
    ]
    const sanitizedInputs = `0x${create2Inputs
      .map((i) => i.slice(2))
      .join('')}` as Hex
    return getAddress(`0x${keccak256(sanitizedInputs).slice(-40)}`)
  }
}
