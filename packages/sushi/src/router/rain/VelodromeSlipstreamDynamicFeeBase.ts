import { Address, Log, parseAbiItem } from 'viem'
import {
  DEFAULT_FEE_CONFIG,
  FeeType,
  SlipstreamEventsAbi,
  SlipstreamFeeConfig,
  SlipstreamPool,
  VelodromeSlipstreamBaseProvider,
  ZERO_FEE_INDICATOR,
} from './VelodromeSlipstreamBase.js'

/**
 * dynamicFeeConfig(pool) of the first DynamicSwapFeeModule versions
 * (velodrome slipstream #187..#195, deployed on optimism)
 */
export const dynamicFeeConfigAbi = [
  {
    inputs: [{ internalType: 'address', name: '_pool', type: 'address' }],
    name: 'dynamicFeeConfig',
    outputs: [
      { internalType: 'uint24', name: 'baseFee', type: 'uint24' },
      { internalType: 'uint24', name: 'feeCap', type: 'uint24' },
      { internalType: 'uint64', name: 'scalingFactor', type: 'uint64' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/**
 * dynamicFeeConfig(pool) of the DynamicSwapFeeModule version with the
 * initial fee patch (aerodrome slipstream #41 / velodrome slipstream #199,
 * deployed on base)
 */
export const dynamicFeeConfigV2Abi = [
  {
    inputs: [{ internalType: 'address', name: '_pool', type: 'address' }],
    name: 'dynamicFeeConfig',
    outputs: [
      { internalType: 'uint24', name: 'baseFee', type: 'uint24' },
      { internalType: 'uint24', name: 'feeCap', type: 'uint24' },
      { internalType: 'uint64', name: 'scalingFactor', type: 'uint64' },
      { internalType: 'bool', name: 'initialFeeEnabled', type: 'bool' },
      { internalType: 'uint24', name: 'initialFee', type: 'uint24' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

const moduleDefaultsAbi = [
  {
    inputs: [],
    name: 'defaultScalingFactor',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'defaultFeeCap',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const SlipstreamDynamicFeeEventsAbi = [
  ...SlipstreamEventsAbi,
  parseAbiItem(
    'event ScalingFactorSet(address indexed pool, uint256 indexed scalingFactor)',
  ),
  parseAbiItem('event FeeCapSet(address indexed pool, uint256 indexed feeCap)'),
  parseAbiItem('event DynamicFeeReset(address indexed pool)'),
  parseAbiItem(
    'event DefaultScalingFactorSet(uint256 indexed defaultScalingFactor)',
  ),
  parseAbiItem('event DefaultFeeCapSet(uint256 indexed defaultFeeCap)'),
  parseAbiItem('event SecondsAgoSet(uint32 indexed secondsAgo)'),
]

export const SlipstreamDynamicFeeV2EventsAbi = [
  ...SlipstreamDynamicFeeEventsAbi,
  parseAbiItem(
    'event InitialFeeSet(address indexed pool, uint24 indexed initialFee)',
  ),
  parseAbiItem('event InitialFeeDisabled(address indexed pool)'),
]

/**
 * Provider for slipstream CL factories whose swapFeeModule is a
 * DynamicSwapFeeModule (first versions, without initial fee). The charged
 * fee is:
 *
 *   base = baseFee == 420 ? 0 : baseFee != 0 ? baseFee : tickSpacingToFee
 *   K, cap = pool.scalingFactor != 0 ? pool's : module defaults
 *   fee = min(base + K * |tick - twapTick(secondsAgo)| / 1e6, cap)
 *
 * The settings (baseFee, feeCap, scalingFactor, defaults) are all event
 * tracked. The tick vs twap term however changes every block without any
 * event, so pools with a non zero effective scaling factor are "volatile"
 * and get their fee() re-read from chain on every update round. Pools with
 * a zero effective scaling factor resolve exactly like the custom fee
 * module.
 *
 * Not modeled: the module's tx.origin based discount, which only applies
 * to registered addresses
 */
export abstract class VelodromeSlipstreamDynamicFeeBaseProvider extends VelodromeSlipstreamBaseProvider {
  // module wide defaults, apply to pools with scalingFactor == 0
  defaultScalingFactor: Record<number, bigint> = {}
  defaultFeeCap: Record<number, bigint> = {}

  // abi of the module's dynamicFeeConfig(pool), child versions override
  protected feeConfigAbi:
    | typeof dynamicFeeConfigAbi
    | typeof dynamicFeeConfigV2Abi = dynamicFeeConfigAbi

  override eventsAbi = SlipstreamDynamicFeeEventsAbi as any

  protected override async initFeeModule(blockNumber?: bigint) {
    const results = await this.client
      .multicall({
        multicallAddress: this.client.chain?.contracts?.multicall3?.address!,
        allowFailure: true,
        blockNumber,
        contracts: (['defaultScalingFactor', 'defaultFeeCap'] as const).map(
          (functionName) => ({
            address: this.swapFeeModule[this.chainId]!,
            abi: moduleDefaultsAbi,
            functionName,
          }),
        ),
      })
      .catch((e) => {
        console.warn(
          `${this.getLogPrefix()} - INIT: failed to get swapFeeModule defaults, message: ${
            e.message
          }`,
        )
        return undefined
      })
    const scalingFactor = results?.[0]?.result
    const feeCap = results?.[1]?.result
    if (typeof scalingFactor !== 'bigint' || typeof feeCap !== 'bigint') {
      console.warn(
        `${this.getLogPrefix()} - INIT: swapFeeModule is not a DynamicSwapFeeModule or the read failed`,
      )
      return false
    }
    this.defaultScalingFactor[this.chainId] = scalingFactor
    this.defaultFeeCap[this.chainId] = feeCap
    return true
  }

  protected override async readFeeConfigs(
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
          abi: this.feeConfigAbi,
          functionName: 'dynamicFeeConfig',
          args: [pool.address],
        })),
      })
      .catch((e) => {
        console.warn(
          `${this.getLogPrefix()} - multicall failed to get dynamicFeeConfig, message: ${
            e.message
          }`,
        )
        return undefined
      })
    if (!results) return undefined
    const configs = results.map((res) => {
      const config = res?.result
      if (!Array.isArray(config)) return undefined
      return {
        ...DEFAULT_FEE_CONFIG,
        baseFee: Number(config[0]),
        feeCap: Number(config[1]),
        scalingFactor: BigInt(config[2]),
        initialFeeEnabled: Boolean(config[3] ?? false),
        initialFee: Number(config[4] ?? 0),
      }
    })
    if (configs.every((config) => config === undefined)) {
      // every decode failed, most likely the module's dynamicFeeConfig
      // struct shape doesnt match this provider's fee module version
      console.warn(
        `${this.getLogPrefix()} - failed to decode dynamicFeeConfig of all pools, the swapFeeModule version might not match this provider`,
      )
    }
    return configs
  }

  /**
   * Effective scaling factor and fee cap of a pool, the module falls back
   * to its defaults for both when the pool's own scaling factor is zero
   */
  protected effectiveDynamicParams(config: SlipstreamFeeConfig): {
    scalingFactor: bigint
    feeCap: bigint
  } {
    if (config.scalingFactor !== 0n)
      return {
        scalingFactor: config.scalingFactor,
        feeCap: BigInt(config.feeCap),
      }
    return {
      scalingFactor: this.defaultScalingFactor[this.chainId] ?? 0n,
      feeCap: this.defaultFeeCap[this.chainId] ?? 0n,
    }
  }

  protected override isVolatile(pool: {
    feeConfig: SlipstreamFeeConfig
  }): boolean {
    // getFee() returns 0 for ZERO_FEE_INDICATOR before any dynamic or
    // initial fee logic, so such pools never need a fee() read
    if (pool.feeConfig.baseFee === ZERO_FEE_INDICATOR) return false
    const { scalingFactor } = this.effectiveDynamicParams(pool.feeConfig)
    return scalingFactor !== 0n || pool.feeConfig.initialFeeEnabled
  }

  /**
   * A non volatile pool has a zero effective scaling factor, so the module
   * uses its defaults and the fee is min(base, defaultFeeCap)
   */
  protected override resolveStaticFee(pool: {
    tickSpacing: number
    feeType: FeeType
    feeConfig: SlipstreamFeeConfig
  }): number | undefined {
    const base = super.resolveStaticFee(pool)
    if (typeof base !== 'number' || pool.feeType === FeeType.Zero) return base
    const { feeCap } = this.effectiveDynamicParams(pool.feeConfig)
    return feeCap < BigInt(base) ? Number(feeCap) : base
  }

  protected override otherFactoryEventCases(log: Log, event: any) {
    switch (event.eventName) {
      case 'ScalingFactorSet':
      case 'FeeCapSet':
      case 'DynamicFeeReset': {
        const pool = this.pools.get(
          event.args.pool.toLowerCase(),
        ) as SlipstreamPool
        if (pool && log.blockNumber! >= pool.blockNumber) {
          pool.blockNumber = log.blockNumber!
          const config = { ...pool.feeConfig }
          if (event.eventName === 'ScalingFactorSet') {
            config.scalingFactor = BigInt(event.args.scalingFactor)
          } else if (event.eventName === 'FeeCapSet') {
            config.feeCap = Number(event.args.feeCap)
          } else {
            config.feeCap = 0
            config.scalingFactor = 0n
            config.initialFeeEnabled = false
            config.initialFee = 0
          }
          this.applyFeeConfig(pool, config)
          this.refreshStaticFee(pool)
        }
        break
      }
      case 'DefaultScalingFactorSet': {
        // changes which pools are volatile, so re-resolve all of them,
        // the volatile ones get re-read at afterProcessLog anyway
        this.defaultScalingFactor[this.chainId] = BigInt(
          event.args.defaultScalingFactor,
        )
        this.pools.forEach((pool) =>
          this.refreshStaticFee(pool as SlipstreamPool),
        )
        break
      }
      case 'DefaultFeeCapSet': {
        // caps the static fee of non volatile pools, so re-resolve all of
        // them, the volatile ones get re-read at afterProcessLog anyway
        this.defaultFeeCap[this.chainId] = BigInt(event.args.defaultFeeCap)
        this.pools.forEach((pool) =>
          this.refreshStaticFee(pool as SlipstreamPool),
        )
        break
      }
      case 'SecondsAgoSet': {
        // only affects volatile pools which get re-read anyway
        break
      }
      default:
    }
  }
}

/**
 * Provider for slipstream CL factories whose swapFeeModule is the
 * DynamicSwapFeeModule version with the initial fee patch. On top of the
 * dynamic fee, a pool can opt into an initial fee that is charged instead
 * of the dynamic fee by the first swap of a block (ie while no observation
 * has been written in the block yet).
 *
 * Pools with initial fee enabled are volatile too. Their fee() read
 * returns the initial fee unless a swap already landed in the block of the
 * read, which is the same fee our own swap pays if it is the first one in
 * its block, so it's taken as is
 */
export abstract class VelodromeSlipstreamDynamicFeeV2BaseProvider extends VelodromeSlipstreamDynamicFeeBaseProvider {
  protected override feeConfigAbi = dynamicFeeConfigV2Abi
  override eventsAbi = SlipstreamDynamicFeeV2EventsAbi as any

  protected override otherFactoryEventCases(log: Log, event: any) {
    switch (event.eventName) {
      case 'InitialFeeSet':
      case 'InitialFeeDisabled': {
        const pool = this.pools.get(
          event.args.pool.toLowerCase(),
        ) as SlipstreamPool
        if (pool && log.blockNumber! >= pool.blockNumber) {
          pool.blockNumber = log.blockNumber!
          const enabled = event.eventName === 'InitialFeeSet'
          this.applyFeeConfig(pool, {
            ...pool.feeConfig,
            initialFeeEnabled: enabled,
            initialFee: enabled ? Number(event.args.initialFee) : 0,
          })
          this.refreshStaticFee(pool)
        }
        break
      }
      default:
        super.otherFactoryEventCases(log, event)
    }
  }
}
