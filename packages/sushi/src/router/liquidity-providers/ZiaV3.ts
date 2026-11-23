import { PublicClient } from 'viem'
import { ChainId } from '../../chain/index.js'
import { UniswapV3BaseProvider } from '../rain/UniswapV3Base.js'
import { LiquidityProviders } from './LiquidityProvider.js'

/**
 * Zia (https://app.zia.finance) on 0G, a Uniswap V3 deployment with the
 * default fee tiers. The pool addresses take the Uniswap V3 init code hash,
 * and the TickLens is the one of the same deployment
 */
export class ZiaV3Provider extends UniswapV3BaseProvider {
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.ZEROG]: '0x6F3945Ab27296D1D66D8EEB042ff1B4fb2E0CE70',
    } as const
    const initCodeHash = {
      [ChainId.ZEROG]:
        '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
    } as const
    const tickLens = {
      [ChainId.ZEROG]: '0xAEA8Bfd12ec08622444E6112ec7089aC2ceFBba5',
    } as const
    super(chainId, web3Client, factory, initCodeHash, tickLens)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.ZiaV3
  }
  getPoolProviderName(): string {
    return 'ZiaV3'
  }
}
