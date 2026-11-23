import type { Address, Hex } from 'viem'
import type { MultiRoute, RouteLeg, UniV4Pool } from '../../tines/index.js'
import { HEXer } from '../HEXer.js'
import { LiquidityProviders } from '../liquidity-providers/index.js'
import { PoolCode, RPPoolType } from './PoolCode.js'

/** the PoolKey of a PancakeSwap Infinity CL pool, its pool manager is the address of the tines pool */
export interface PancakeSwapInfinityCLPoolKey {
  /** lowercase, the zero address for the native currency */
  currency0: Address
  /** lowercase */
  currency1: Address
  /** lowercase */
  hooks: Address
  /** the lp fee in 1/1_000_000 fractions, or the dynamic fee flag 0x800000 */
  fee: number
  /** the hooks permission bitmap in bits 0-15 and the tick spacing in bits 16-39, 32 bytes */
  parameters: Hex
}

/**
 * The pool code of a PancakeSwap Infinity CL pool. Only a route processor
 * with an Infinity CL swap (RouteProcessor6) can swap through it, the older
 * ones get 'unsupported'. The tines pool is a UniV4Pool: the CL math is the
 * one of Uniswap V4, its address is the pool manager
 */
export class PancakeSwapInfinityCLPoolCode extends PoolCode {
  poolKey: PancakeSwapInfinityCLPoolKey
  /** the Vault the pool manager settles with, the swap locks it */
  vault: Address

  constructor(
    pool: UniV4Pool,
    poolKey: PancakeSwapInfinityCLPoolKey,
    vault: Address,
    liquidityProvider: LiquidityProviders,
    providerName: string,
  ) {
    super(
      pool,
      liquidityProvider,
      poolKey.fee & 0x800000
        ? `${providerName} dynamic`
        : `${providerName} ${poolKey.fee / 10_000}%`,
    )
    this.poolKey = poolKey
    this.vault = vault
  }

  override getStartPoint(): string {
    return PoolCode.RouteProcessorAddress
  }

  getSwapCodeForRouteProcessor(): string {
    return 'unsupported'
  }

  override getSwapCodeForRouteProcessor2(): string {
    return 'unsupported'
  }

  override getSwapCodeForRouteProcessor4(): string {
    return 'unsupported'
  }

  /**
   * The RouteProcessor6 code of an Infinity CL swap: the Vault, the pool
   * manager, the output token, the PoolKey fee, parameters and hooks, the
   * direction, empty hook data and the receiver. The contract builds the
   * PoolKey from the input and the output tokens, the native token is '' in
   * tines and 0x0 in a PoolKey
   */
  override getSwapCodeForRouteProcessor6(
    leg: RouteLeg,
    _route: MultiRoute,
    to: string,
  ): string {
    const zeroForOne =
      leg.tokenFrom.address.toLowerCase() ===
      this.pool.token0.address.toLowerCase()
    return new HEXer()
      .uint8(RPPoolType.PancakeSwapInfinityCL)
      .address(this.vault)
      .address(this.pool.address)
      .address(leg.tokenTo.address)
      .uint24(this.poolKey.fee)
      .bytes32(this.poolKey.parameters)
      .address(this.poolKey.hooks)
      .bool(zeroForOne)
      .bytes('')
      .address(to)
      .toString()
  }
}
