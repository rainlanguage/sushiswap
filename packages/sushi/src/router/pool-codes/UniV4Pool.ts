import type { MultiRoute, RouteLeg, UniV4Pool } from '../../tines/index.js'
import { HEXer } from '../HEXer.js'
import type { UniswapV4PoolKey } from '../liquidity-providers/UniswapV4Base.js'
import { LiquidityProviders } from '../liquidity-providers/index.js'
import { PoolCode, RPPoolType } from './PoolCode.js'

/**
 * The pool code of a Uniswap V4 pool. Only a route processor with a V4 swap
 * (RouteProcessor6) can swap through it, the older ones get 'unsupported'.
 * The PoolKey is kept as it is, a swap needs its fee, while the fee of the
 * tines pool is the swap fee, which includes the protocol fee
 */
export class UniV4PoolCode extends PoolCode {
  poolKey: UniswapV4PoolKey

  constructor(
    pool: UniV4Pool,
    poolKey: UniswapV4PoolKey,
    liquidityProvider: LiquidityProviders,
    providerName: string,
  ) {
    super(pool, liquidityProvider, `${providerName} ${poolKey.fee / 10_000}%`)
    this.poolKey = poolKey
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
   * The RouteProcessor6 code of a V4 swap: the PoolManager, the output token,
   * the PoolKey fee, tick spacing and hooks, the direction, empty hook data
   * and the receiver. The contract builds the PoolKey from the input and the
   * output tokens, the native token is '' in tines and 0x0 in a PoolKey
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
      .uint8(RPPoolType.UniV4)
      .address(this.pool.address)
      .address(leg.tokenTo.address)
      .uint24(this.poolKey.fee)
      .uint24(this.poolKey.tickSpacing)
      .address(this.poolKey.hooks)
      .bool(zeroForOne)
      .bytes('')
      .address(to)
      .toString()
  }
}
