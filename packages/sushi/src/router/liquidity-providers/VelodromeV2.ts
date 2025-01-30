import { PublicClient } from 'viem'
import { ChainId } from '../../chain/index.js'
import { LiquidityProviders } from './LiquidityProvider.js'
import { VelodromeV2BaseProvider } from './VelodromeV2Base.js'

export class VelodromeV2Provider extends VelodromeV2BaseProvider {
  override fee = 0.01
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.OPTIMISM]: '0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a',
    } as const
    const implementation = {
      [ChainId.OPTIMISM]: '0x95885Af5492195F0754bE71AD1545Fe81364E531',
    } as const
    super(chainId, web3Client, factory, implementation)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.VelodromeV2
  }
  getPoolProviderName(): string {
    return 'VelodromeV2'
  }
}
