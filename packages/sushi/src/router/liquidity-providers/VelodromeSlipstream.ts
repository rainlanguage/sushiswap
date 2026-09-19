import { PublicClient } from 'viem'
import { ChainId } from '../../chain/index.js'
import { VelodromeSlipstreamDynamicFeeBaseProvider } from '../rain/VelodromeSlipstreamDynamicFeeBase.js'
import { LiquidityProviders } from './LiquidityProvider.js'

// factory 0xCc0b... runs the first DynamicSwapFeeModule version (no initial fee)
export class VelodromeSlipstreamProvider extends VelodromeSlipstreamDynamicFeeBaseProvider {
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.OPTIMISM]: '0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F',
    } as const
    const tickLens = {
      [ChainId.OPTIMISM]: '0x49C6FDCb3D5b2CecD8baff66c8e94b9B261ad925',
    } as const
    super(chainId, web3Client, factory, tickLens)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.VelodromeSlipstream
  }
  getPoolProviderName(): string {
    return 'VelodromeSlipstream'
  }
}

// factory 0xe13D... (march 2025) runs the second DynamicSwapFeeModule
// version: bulk fee cap / scaling factor setters, still no initial fee and
// a 3 word dynamicFeeConfig, so it shares the base of the first factory
export class VelodromeSlipstreamV2Provider extends VelodromeSlipstreamDynamicFeeBaseProvider {
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.OPTIMISM]: '0xe13Dd1fbA721Aa81a1826D9523AC9BC7d260c879',
    } as const
    const tickLens = {
      [ChainId.OPTIMISM]: '0x49C6FDCb3D5b2CecD8baff66c8e94b9B261ad925',
    } as const
    super(chainId, web3Client, factory, tickLens)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.VelodromeSlipstreamV2
  }
  getPoolProviderName(): string {
    return 'VelodromeSlipstreamV2'
  }
}
