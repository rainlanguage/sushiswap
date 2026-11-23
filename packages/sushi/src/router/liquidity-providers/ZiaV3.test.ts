// the liquidity providers index must load before any provider file to
// avoid an import cycle that leaves the base classes undefined
import './index.js'

import { http, createPublicClient } from 'viem'
import { describe, expect, it } from 'vitest'
import { ChainId } from '../../chain/index.js'
import { USDC, WNATIVE } from '../../currency/index.js'
import { LiquidityProviders } from './LiquidityProvider.js'
import { ZiaV3Provider } from './ZiaV3.js'

// offline tests, no rpc calls are made
const client = createPublicClient({ transport: http('http://localhost:1') })

describe('ZiaV3Provider', () => {
  it('computes the addresses of the Zia pools on 0G', () => {
    const provider = new ZiaV3Provider(ChainId.ZEROG, client)
    const W0G = WNATIVE[ChainId.ZEROG]
    const USDCE = USDC[ChainId.ZEROG]
    const pair = [W0G.address, USDCE.address]
      .map((a) => a.toLowerCase())
      .sort()
      .join()
    const pools = provider.getStaticPools(W0G, USDCE)
    const poolOf = (fee: number) =>
      pools
        .find(
          (p) =>
            p.fee === fee &&
            [p.token0.address, p.token1.address]
              .map((a) => a.toLowerCase())
              .sort()
              .join() === pair,
        )
        ?.address.toLowerCase()
    // the W0G and USDC.e pools of the factory, as its getPool gives them on 0G
    expect(poolOf(3000)).toBe('0x23336572435ec92d25ef0dd2d468b2a1abf7bb4f')
    expect(poolOf(10000)).toBe('0x159fe1d57b464ed60e2bfbbca0df444999131673')
    expect(provider.getType()).toBe(LiquidityProviders.ZiaV3)
  })

  it('is only on 0G', () => {
    expect(() => new ZiaV3Provider(ChainId.ETHEREUM, client)).toThrow()
  })
})
