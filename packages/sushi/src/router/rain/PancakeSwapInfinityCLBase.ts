import {
  type Address,
  type ContractFunctionParameters,
  type Hex,
  type Log,
  type PublicClient,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  numberToHex,
  parseAbiItem,
  parseAbiParameters,
  toEventSelector,
} from 'viem'
import {
  pancakeSwapInfinityCLPoolManagerAbi_getPoolBitmapInfo,
  pancakeSwapInfinityCLPoolManagerAbi_getPoolTickInfo,
} from '../../abi/index.js'
import type { ChainId } from '../../chain/index.js'
import type { Token } from '../../currency/index.js'
import {
  type UniswapV4FeeTier,
  type UniswapV4PoolState,
  type UniswapV4StaticPool,
  uniswapV4SwapFee,
} from '../liquidity-providers/UniswapV4Base.js'
import {
  PancakeSwapInfinityCLPoolCode,
  type PoolCode,
} from '../pool-codes/index.js'
import { UniswapV4BaseProvider } from './UniswapV4Base.js'

/** the pool manager events that change the state of a pool, or tell it exists */
export const PancakeSwapInfinityCLEventsAbi = [
  parseAbiItem(
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, address hooks, uint24 fee, bytes32 parameters, uint160 sqrtPriceX96, int24 tick)',
  ),
  parseAbiItem(
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee, uint16 protocolFee)',
  ),
  parseAbiItem(
    'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  ),
  parseAbiItem(
    'event ProtocolFeeUpdated(bytes32 indexed id, uint24 protocolFee)',
  ),
  parseAbiItem(
    'event DynamicLPFeeUpdated(bytes32 indexed id, uint24 dynamicLPFee)',
  ),
] as const

const DYNAMIC_LP_FEE_UPDATED = PancakeSwapInfinityCLEventsAbi[4]
const DYNAMIC_LP_FEE_UPDATED_TOPIC = toEventSelector(DYNAMIC_LP_FEE_UPDATED)

/** the fee tiers of the PancakeSwap Infinity CL pools without hooks */
export const PANCAKESWAP_INFINITY_CL_DEFAULT_FEE_TIERS: UniswapV4FeeTier[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 2500, tickSpacing: 50 },
  { fee: 10_000, tickSpacing: 200 },
]

/** The PoolKey parts every pool of one known hooks contract has */
export interface PancakeSwapInfinityCLHookSetup {
  /** lowercase, UNISWAP_V4_ZERO_HOOKS for the pools without hooks */
  hooks: Address
  /** the hooks permission bitmap, the low 16 bits of the PoolKey parameters */
  bitmap: number
  /** the lp fees of the pools with their tick spacings, the dynamic fee flag 0x800000 for a dynamic fee */
  feeTiers: UniswapV4FeeTier[]
}

/** The PoolKey parameters of a CL pool: the hooks permission bitmap in bits 0-15, the tick spacing in bits 16-39 */
export function pancakeSwapInfinityCLParameters(
  bitmap: number,
  tickSpacing: number,
): Hex {
  return numberToHex((BigInt(tickSpacing) << 16n) | BigInt(bitmap & 0xffff), {
    size: 32,
  })
}

/** PoolId = keccak256(abi.encode(PoolKey)), the PoolKey of PancakeSwap Infinity has the pool manager and the parameters */
export function computePancakeSwapInfinityCLPoolId({
  currency0,
  currency1,
  hooks,
  poolManager,
  fee,
  parameters,
}: {
  currency0: Address
  currency1: Address
  hooks: Address
  poolManager: Address
  fee: number
  parameters: Hex
}): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters',
      ),
      [
        currency0.toLowerCase() as Address,
        currency1.toLowerCase() as Address,
        hooks.toLowerCase() as Address,
        poolManager.toLowerCase() as Address,
        fee,
        parameters,
      ],
    ),
  )
}

/** a PancakeSwap Infinity CL pool that may exist, with its PoolKey parameters */
export interface PancakeSwapInfinityCLStaticPool extends UniswapV4StaticPool {
  parameters: Hex
}

/** the state of an existing PancakeSwap Infinity CL pool, with its PoolKey parameters */
export interface PancakeSwapInfinityCLPoolState extends UniswapV4PoolState {
  parameters: Hex
}

/**
 * The PancakeSwap Infinity CL provider of RainDataFetcher. The CL math, the
 * pool ids in topic 1 of the pool manager logs and the cache are the ones of
 * the Uniswap V4 provider, the differences are:
 * - the PoolKey has the pool manager and a parameters word, the tick spacing
 *   and the hooks permission bitmap are packed in it, so a pool id needs the
 *   bitmap of its hooks
 * - the pools are the ones of the known hooks setups of the chain, see
 *   hookSetups, the pools without hooks among them
 * - the state is read from the CL pool manager itself: getSlot0 and
 *   getLiquidity as a StateView has them, the tick words with its own
 *   getPoolBitmapInfo and getPoolTickInfo, see tickBitmapRead
 * - the pool manager events have other Initialize and Swap signatures, and a
 *   DynamicLPFeeUpdated
 * - a swap locks the Vault, see PancakeSwapInfinityCLPoolCode
 *
 * The quote takes the CL math with the lp fee and the protocol fee only, a
 * charge a hook takes is not in it. The Initialize log discovery is not
 * supported
 */
export abstract class PancakeSwapInfinityCLBaseProvider extends UniswapV4BaseProvider {
  /** the Vault each pool manager settles with, by chain id */
  vault: Record<number, Address>
  /** the known hooks setups, by chain id, see getStaticPools */
  hookSetups: Record<number, PancakeSwapInfinityCLHookSetup[]>
  override eventsAbi = [PancakeSwapInfinityCLEventsAbi[0]]
  override poolManagerEventsAbi = PancakeSwapInfinityCLEventsAbi

  constructor(
    chainId: ChainId,
    web3Client: PublicClient,
    poolManager: Record<number, Address>,
    vault: Record<number, Address>,
    hookSetups: Record<number, PancakeSwapInfinityCLHookSetup[]>,
  ) {
    // the pool state is read from the pool manager, it is the state reader
    super(chainId, web3Client, poolManager, poolManager)
    this.vault = vault
    this.hookSetups = hookSetups
    if (!(chainId in this.vault) || !(chainId in this.hookSetups)) {
      throw new Error(
        `${this.getType()} cannot be instantiated for chainid ${chainId}, no vault or hook setups`,
      )
    }
  }

  getVault(): Address {
    return this.vault[this.chainId]!
  }

  /** The pools of every known hooks setup at its fee tiers, for the pairs of currencyPairs */
  override getStaticPools(
    t0: Token,
    t1: Token,
    extraPairs?: [Token, Token][],
  ): UniswapV4StaticPool[] {
    const poolManager = this.getPoolManager()
    const pools = new Map<string, PancakeSwapInfinityCLStaticPool>()
    this.currencyPairs(t0, t1, extraPairs).forEach((pair) => {
      const { token0, token1, currency0, currency1 } = pair
      this.hookSetups[this.chainId]!.forEach(({ hooks, bitmap, feeTiers }) => {
        feeTiers.forEach(({ fee, tickSpacing }) => {
          const parameters = pancakeSwapInfinityCLParameters(
            bitmap,
            tickSpacing,
          )
          const id = computePancakeSwapInfinityCLPoolId({
            currency0,
            currency1,
            hooks,
            poolManager,
            fee,
            parameters,
          })
          pools.set(id, {
            currency0,
            currency1,
            fee,
            tickSpacing,
            hooks: hooks.toLowerCase() as Address,
            parameters,
            id,
            token0,
            token1,
          })
        })
      })
    })
    return Array.from(pools.values())
  }

  /** the Initialize log discovery is not supported, the pools are the ones of the hooks setups */
  override async getPoolsFromLogs(): Promise<UniswapV4StaticPool[]> {
    return []
  }

  override tickBitmapRead(id: Hex, word: number): ContractFunctionParameters {
    return {
      address: this.getPoolManager(),
      abi: pancakeSwapInfinityCLPoolManagerAbi_getPoolBitmapInfo,
      functionName: 'getPoolBitmapInfo',
      args: [id, word],
    }
  }

  override tickLiquidityRead(
    id: Hex,
    tick: number,
  ): ContractFunctionParameters {
    return {
      address: this.getPoolManager(),
      abi: pancakeSwapInfinityCLPoolManagerAbi_getPoolTickInfo,
      functionName: 'getPoolTickInfo',
      args: [id, tick],
    }
  }

  override liquidityNetOf(result: unknown): bigint | undefined {
    return (result as { liquidityNet: bigint }).liquidityNet
  }

  /** The pool code of a cached pool, undefined while its tines pool is not built or for a state with no PoolKey parameters */
  override poolCodeOf(state: UniswapV4PoolState): PoolCode | undefined {
    const { parameters } = state as Partial<PancakeSwapInfinityCLPoolState>
    if (!parameters) return undefined
    const pool = this.tinesPoolOf(state)
    if (!pool) return undefined
    return new PancakeSwapInfinityCLPoolCode(
      pool,
      {
        currency0: state.currency0,
        currency1: state.currency1,
        hooks: state.hooks,
        fee: state.fee,
        parameters,
      },
      this.getVault(),
      this.getType(),
      this.getPoolProviderName(),
    )
  }

  /**
   * The Uniswap V4 handling of the pool manager logs, and a
   * DynamicLPFeeUpdated sets the lp fee of a dynamic fee pool. A fee a hook
   * gives for one swap only is not seen
   */
  override processLog(log: Log): boolean {
    if (log.topics[0] !== DYNAMIC_LP_FEE_UPDATED_TOPIC)
      return super.processLog(log)
    const id = this.poolKeyOfLog(log)
    const pool = id === undefined ? undefined : this.pools.get(id)
    const block = log.blockNumber
    if (!pool || block === null || block < pool.blockNumber) return false
    let dynamicLPFee: number
    try {
      dynamicLPFee = decodeEventLog({
        abi: [DYNAMIC_LP_FEE_UPDATED],
        data: log.data,
        topics: log.topics,
      }).args.dynamicLPFee
    } catch {
      return false
    }
    pool.blockNumber = block
    pool.lpFee = dynamicLPFee
    pool.swapFee = uniswapV4SwapFee(pool.lpFee, pool.protocolFee)
    return false
  }
}
