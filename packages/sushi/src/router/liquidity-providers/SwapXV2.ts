import { getCreate2Address } from '@ethersproject/address'
import { Address, PublicClient, encodePacked, keccak256 } from 'viem'
import { ChainId } from '../../chain/index.js'
import { Token } from '../../currency/Token.js'
import { getCurrencyCombinations } from '../get-currency-combinations.js'
import { LiquidityProviders } from './LiquidityProvider.js'
import { StaticPool, UniswapV2BaseProvider } from './UniswapV2Base.js'

export class SwapxV2Provider extends UniswapV2BaseProvider {
  STABLE_FEE = 0.0001
  VOLATILE_FEE = 0.01
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.SONIC]: '0x05c1be79d3aC21Cc4B727eeD58C9B2fF757F5663',
    } as const
    const initCodeHash = {
      [ChainId.SONIC]:
        '0x6c45999f36731ff6ab43e943fca4b5a700786bbb202116cf6633b32039161e05',
    } as const
    super(chainId, web3Client, factory, initCodeHash)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.SwapxV2
  }
  getPoolProviderName(): string {
    return 'SwapxV2'
  }

  override getStaticPools(t1: Token, t2: Token): StaticPool[] {
    const currencyCombination = getCurrencyCombinations(
      this.chainId,
      t1,
      t2,
    ).map(([c0, c1]) => (c0.sortsBefore(c1) ? [c0, c1] : [c1, c0]))
    return currencyCombination.flatMap((combination) => [
      {
        address: this.computePoolAddress(
          combination[0]!,
          combination[1]!,
          true,
        ),
        token0: combination[0]!,
        token1: combination[1]!,
        fee: this.STABLE_FEE,
      },
      {
        address: this.computePoolAddress(
          combination[0]!,
          combination[1]!,
          false,
        ),
        token0: combination[0]!,
        token1: combination[1]!,
        fee: this.VOLATILE_FEE,
      },
    ])
  }

  computePoolAddress(t1: Token, t2: Token, stable: boolean): Address {
    return getCreate2Address(
      this.factory[this.chainId as keyof typeof this.factory]!,
      keccak256(
        encodePacked(
          ['address', 'address', 'bool'],
          [t1.address as Address, t2.address as Address, stable],
        ),
      ),
      this.initCodeHash[this.chainId as keyof typeof this.initCodeHash]!,
    ) as Address
  }
}
