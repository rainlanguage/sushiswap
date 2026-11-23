import type { Address, PublicClient } from 'viem'
import { ChainId } from '../../chain/index.js'
import {
  PANCAKESWAP_INFINITY_CL_DEFAULT_FEE_TIERS,
  PancakeSwapInfinityCLBaseProvider,
  type PancakeSwapInfinityCLHookSetup,
} from '../rain/PancakeSwapInfinityCLBase.js'
import { LiquidityProviders } from './LiquidityProvider.js'
import {
  UNISWAP_V4_DYNAMIC_FEE_FLAG,
  UNISWAP_V4_ZERO_HOOKS,
} from './UniswapV4Base.js'

// https://comfy.fun/docs/build/integrate, a PancakeSwap Infinity CL deployment
export class ComfyProvider extends PancakeSwapInfinityCLBaseProvider {
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const poolManager: Record<number, Address> = {
      [ChainId.ZEROG]: '0xaabd31f24914b48daea998e69683225e289d08b0',
    }
    const vault: Record<number, Address> = {
      [ChainId.ZEROG]: '0x5809c1ff809cfc6fca8518016cdffa8339ba2a3a',
    }
    const hookSetups: Record<number, PancakeSwapInfinityCLHookSetup[]> = {
      [ChainId.ZEROG]: [
        // ComfyLaunchHook, every token comfy launches has one pool of it
        // against native 0G, the hook takes its own charge on each swap
        {
          hooks: '0x809acd73ac30b4e2d2dfd7d35b1fda850dcd4334',
          bitmap: 0xfff,
          feeTiers: [{ fee: 0, tickSpacing: 60 }],
        },
        // IAIOpeningFeeHook, a dynamic fee pool: the hook sets the lp fee of
        // each swap, a buy fee that decays after the opening and a sell fee
        {
          hooks: '0xc912324aca9ea0cc34c2615dc53d5a0465bbad30',
          bitmap: 0x43,
          feeTiers: [{ fee: UNISWAP_V4_DYNAMIC_FEE_FLAG, tickSpacing: 60 }],
        },
        {
          hooks: UNISWAP_V4_ZERO_HOOKS,
          bitmap: 0,
          feeTiers: PANCAKESWAP_INFINITY_CL_DEFAULT_FEE_TIERS,
        },
      ],
    }
    super(chainId, web3Client, poolManager, vault, hookSetups)
  }

  getType(): LiquidityProviders {
    return LiquidityProviders.Comfy
  }

  getPoolProviderName(): string {
    return 'Comfy'
  }
}
