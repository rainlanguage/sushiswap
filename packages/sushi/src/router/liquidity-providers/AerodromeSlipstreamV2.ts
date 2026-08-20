import { PublicClient } from 'viem'
import { ChainId } from '../../chain/index.js'
import { VelodromeSlipstreamBaseProvider } from '../rain/VelodromeSlipstreamBase.js'
import { LiquidityProviders } from './LiquidityProvider.js'

export class AerodromeSlipstreamV2Provider extends VelodromeSlipstreamBaseProvider {
  override DEFAULT_TICK_SPACINGS = [1, 50, 100, 200, 2000, 10, 500] as any
  override tickSpacings: number[] = [...this.DEFAULT_TICK_SPACINGS]
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.BASE]: '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a',
    } as const
    const tickLens = {
      [ChainId.BASE]: '0x3e1116ea5034f5d73a7b530071709d54a4109f5f',
    } as const
    super(chainId, web3Client, factory, tickLens)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.AerodromeSlipstreamV2
  }
  getPoolProviderName(): string {
    return 'AerodromeSlipstreamV2'
  }
}

export class AerodromeSlipstreamV2_1Provider extends VelodromeSlipstreamBaseProvider {
  override DEFAULT_TICK_SPACINGS = [1, 50, 100, 200, 2000] as any
  override tickSpacings: number[] = [...this.DEFAULT_TICK_SPACINGS]
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.BASE]: '0x9592CD9B267748cbfBDe90Ac9F7DF3c437A6d51B',
    } as const
    const tickLens = {
      [ChainId.BASE]: '0x3e1116ea5034f5d73a7b530071709d54a4109f5f',
    } as const
    super(chainId, web3Client, factory, tickLens)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.AerodromeSlipstreamV2_1
  }
  getPoolProviderName(): string {
    return 'AerodromeSlipstreamV2_1'
  }
}

export class AerodromeSlipstreamV2_2Provider extends VelodromeSlipstreamBaseProvider {
  override DEFAULT_TICK_SPACINGS = [1, 50, 100, 200, 2000, 500, 10] as any
  override tickSpacings: number[] = [...this.DEFAULT_TICK_SPACINGS]
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.BASE]: '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef',
    } as const
    const tickLens = {
      [ChainId.BASE]: '0x3e1116ea5034f5d73a7b530071709d54a4109f5f',
    } as const
    super(chainId, web3Client, factory, tickLens)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.AerodromeSlipstreamV2_2
  }
  getPoolProviderName(): string {
    return 'AerodromeSlipstreamV2_2'
  }
}
