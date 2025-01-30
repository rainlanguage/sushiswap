import { PublicClient } from 'viem'
import { ChainId } from '../../chain/index.js'
import { LiquidityProviders } from './LiquidityProvider.js'
import { VelodromeV2BaseProvider } from './VelodromeV2Base.js'

export class AerodromeV2Provider extends VelodromeV2BaseProvider {
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.BASE]: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    } as const
    const implementation = {
      [ChainId.BASE]: '0xA4e46b4f701c62e14DF11B48dCe76A7d793CD6d7',
    } as const
    super(chainId, web3Client, factory, implementation)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.AerodromeV2
  }
  getPoolProviderName(): string {
    return 'AerodromeV2'
  }
}
