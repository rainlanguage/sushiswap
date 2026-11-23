import type { Address, PublicClient } from 'viem'
import { ChainId } from '../../chain/index.js'
import { UniswapV4BaseProvider } from '../rain/UniswapV4Base.js'
import { LiquidityProviders } from './LiquidityProvider.js'

// https://developers.uniswap.org/docs/protocols/v4/deployments
export class UniswapV4Provider extends UniswapV4BaseProvider {
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const poolManager: Record<number, Address> = {
      [ChainId.ETHEREUM]: '0x000000000004444c5dc75cb358380d2e3de08a90',
      [ChainId.OPTIMISM]: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
      [ChainId.BASE]: '0x498581ff718922c3f8e6a244956af099b2652b2b',
      [ChainId.ARBITRUM]: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
      [ChainId.POLYGON]: '0x67366782805870060151383f4bbff9dab53e5cd6',
      [ChainId.BSC]: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
      [ChainId.AVALANCHE]: '0x06380c0e0912312b5150364b9dc4542ba0dbbc85',
      [ChainId.CELO]: '0x288dc841a52fca2707c6947b3a777c5e56cd87bc',
      [ChainId.ROBINHOOD]: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    }
    const stateView: Record<number, Address> = {
      [ChainId.ETHEREUM]: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
      [ChainId.OPTIMISM]: '0xc18a3169788f4f75a170290584eca6395c75ecdb',
      [ChainId.BASE]: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
      [ChainId.ARBITRUM]: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990',
      [ChainId.POLYGON]: '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a',
      [ChainId.BSC]: '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4',
      [ChainId.AVALANCHE]: '0xc3c9e198c735a4b97e3e683f391ccbdd60b69286',
      [ChainId.CELO]: '0xbc21f8720babf4b20d195ee5c6e99c52b76f2bfb',
      [ChainId.ROBINHOOD]: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
    }
    // the PoolManager deployment blocks, the Initialize scan starts there
    const initializeLogsFromBlock: Record<number, bigint> = {
      [ChainId.ETHEREUM]: 21_688_329n,
      [ChainId.OPTIMISM]: 130_947_675n,
      [ChainId.BASE]: 25_350_988n,
      [ChainId.ARBITRUM]: 297_842_872n,
      [ChainId.POLYGON]: 66_980_384n,
      [ChainId.BSC]: 45_970_610n,
      [ChainId.AVALANCHE]: 56_195_376n,
      [ChainId.CELO]: 43_985_163n,
      [ChainId.ROBINHOOD]: 9_070n,
    }
    super(chainId, web3Client, poolManager, stateView, initializeLogsFromBlock)
  }

  getType(): LiquidityProviders {
    return LiquidityProviders.UniswapV4
  }

  getPoolProviderName(): string {
    return 'UniswapV4'
  }
}
