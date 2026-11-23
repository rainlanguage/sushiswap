import { ChainId } from '../chain/index.js'
import type { MultiRoute, RouteLeg } from '../tines/index.js'
import { PoolCode } from './pool-codes/PoolCode.js'
import {
  PermitData,
  RouterLiquiditySource,
} from './tines-to-route-processor-2.js'
import { TinesToRouteProcessor4 } from './tines-to-route-processor-4.js'

/**
 * Codes a route for RouteProcessor6: the RouteProcessor4 code, each pool code
 * gives its RouteProcessor6 swap code, and the native token can go to more
 * than one pool, a Uniswap V4 pool takes the native token itself
 */
export class TinesToRouteProcessor6 extends TinesToRouteProcessor4 {
  protected override nativeMultiLeg = true

  override swapCode(
    leg: RouteLeg,
    route: MultiRoute,
    toAddress: string,
  ): string {
    const pc = this.getPoolCode(leg)
    const to = this.getPoolOutputAddress(leg, route, toAddress)
    return pc.getSwapCodeForRouteProcessor6(leg, route, to)
  }
}

export function getRouteProcessor6Code(
  route: MultiRoute,
  routeProcessorAddress: string,
  toAddress: string,
  pools: Map<string, PoolCode>,
  permits: PermitData[] = [],
  source = RouterLiquiditySource.Sender,
): string {
  const rpc = new TinesToRouteProcessor6(
    routeProcessorAddress,
    route.fromToken.chainId as ChainId,
    pools,
  )
  return rpc.getRouteProcessorCode(route, toAddress, permits, source)
}
