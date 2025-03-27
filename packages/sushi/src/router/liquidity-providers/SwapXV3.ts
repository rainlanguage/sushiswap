import { PublicClient } from 'viem'
import { ChainId } from '../../chain/index.js'
import { AlgebraV2BaseProvider } from './AlgebraV2Base.js'
import { LiquidityProviders } from './LiquidityProvider.js'

export class SwapxV3Provider extends AlgebraV2BaseProvider {
  override readonly BASE_FEE = 500 as any
  override DEFAULT_TICK_SPACING = 60
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.SONIC]: '0x8121a3F8c4176E9765deEa0B95FA2BDfD3016794',
    } as const
    const poolDeployer = {
      [ChainId.SONIC]: '0x885229E48987EA4c68F0aA1bCBff5184198A9188',
    } as const
    const initCodeHash = {
      [ChainId.SONIC]:
        '0xf96d2474815c32e070cd63233f06af5413efc5dcb430aee4ff18cc29007c562d',
    } as const
    const tickLens = {
      [ChainId.SONIC]: '0x8Fc0a2CF22Bbd0abDAc54413e6678F6FcE6Ff35C',
    } as const
    super(chainId, web3Client, factory, initCodeHash, tickLens, poolDeployer)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.SwapxV3
  }
  getPoolProviderName(): string {
    return 'SwapxV3'
  }
}
