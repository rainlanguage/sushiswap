import { PublicClient } from 'viem'
import { ChainId } from '../../chain/index.js'
import { AlgebraV2BaseProvider } from './AlgebraV2Base.js'
import { LiquidityProviders } from './LiquidityProvider.js'

export class HydrexProvider extends AlgebraV2BaseProvider {
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.BASE]: '0x36077D39cdC65E1e3FB65810430E5b2c4D5fA29E',
    } as const
    const initCodeHash = {
      [ChainId.BASE]:
        '0xa18736c3ee97fe3c96c9428c0cc2a9116facec18e84f95f9da30543f8238a782',
    } as const
    const poolDeployer = {
      [ChainId.BASE]: '0x1595A5D101d69D2a2bAB2976839cC8eeEb13Ab94',
    } as const
    const tickLens = {
      [ChainId.BASE]: '0x0044e9642381607Eee1CCF06bae2378C3cB9B863',
    } as const
    super(chainId, web3Client, factory, initCodeHash, tickLens, poolDeployer)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.Hydrex
  }
  getPoolProviderName(): string {
    return 'Hydrex'
  }
}
