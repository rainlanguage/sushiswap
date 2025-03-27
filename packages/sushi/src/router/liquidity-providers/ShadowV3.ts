import { defaultAbiCoder } from '@ethersproject/abi'
import { getCreate2Address } from '@ethersproject/address'
import { keccak256 } from '@ethersproject/solidity'
import { Address, PublicClient } from 'viem'
import { ChainId } from '../../chain/index.js'
import { Currency, Token, Type } from '../../currency/index.js'
import { getCurrencyCombinations } from '../get-currency-combinations.js'
import { LiquidityProviders } from './LiquidityProvider.js'
import { StaticPoolUniV3, UniswapV3BaseProvider } from './UniswapV3Base.js'

/**
 * The default factory enabled fee amounts, denominated in hundredths of bips.
 */
export enum ShadowV3FeeAmount {
  /** 0.01% */
  LOWEST = 100,
  /** 0.025% */
  LOWER = 250,
  /** 0.05% */
  LOW = 500,
  /** 0.3% */
  MEDIUM = 3000,
  /** 1% */
  HIGH = 10000,
  /** 2% */
  HIGHEST = 20000,
}

/**
 * The default factory tick spacings by fee amount.
 */
export const SHADOW_V3_FEE_SPACING_MAP: Record<ShadowV3FeeAmount, number> = {
  [ShadowV3FeeAmount.LOWEST]: 1,
  [ShadowV3FeeAmount.LOWER]: 5,
  [ShadowV3FeeAmount.LOW]: 10,
  [ShadowV3FeeAmount.MEDIUM]: 50,
  [ShadowV3FeeAmount.HIGH]: 100,
  [ShadowV3FeeAmount.HIGHEST]: 200,
}
export const SHADOW_V3_TICK_SPACING_MAP: Record<number, number> = {
  1: ShadowV3FeeAmount.LOWEST,
  5: ShadowV3FeeAmount.LOWER,
  10: ShadowV3FeeAmount.LOW,
  50: ShadowV3FeeAmount.MEDIUM,
  100: ShadowV3FeeAmount.HIGH,
  200: ShadowV3FeeAmount.HIGHEST,
}

export class ShadowV3Provider extends UniswapV3BaseProvider {
  override FEE = ShadowV3FeeAmount
  override TICK_SPACINGS = SHADOW_V3_FEE_SPACING_MAP
  mainFactory: Record<number, Address> = {}
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const poolDeployer = {
      [ChainId.SONIC]: '0x8BBDc15759a8eCf99A92E004E0C64ea9A5142d59',
    } as const
    const initCodeHash = {
      [ChainId.SONIC]:
        '0xc701ee63862761c31d620a4a083c61bdc1e81761e6b9c9267fd19afd22e0821d',
    } as const
    const tickLens = {
      [ChainId.SONIC]: '0x095bBC37f439EEf5dcF733205B51447d03202E14',
    } as const
    const factory = {
      [ChainId.SONIC]: '0xcD2d0637c94fe77C2896BbCBB174cefFb08DE6d7',
    } as const
    super(chainId, web3Client, poolDeployer, initCodeHash, tickLens)
    this.mainFactory = factory
    if (!(chainId in this.mainFactory)) {
      throw new Error(
        `${this.getType()} cannot be instantiated for chainid ${chainId}, no main factory`,
      )
    }
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.ShadowV3
  }
  getPoolProviderName(): string {
    return 'ShadowV3'
  }

  override getStaticPools(t1: Token, t2: Token): StaticPoolUniV3[] {
    const tickSpacingList = Object.values(this.TICK_SPACINGS).filter(
      (v) => typeof v === 'number',
    )
    const currencyCombinations = getCurrencyCombinations(this.chainId, t1, t2)

    const allCurrencyCombinationsWithAllTickSpacings: [Type, Type, number][] =
      currencyCombinations.reduce<[Currency, Currency, number][]>(
        (list, [tokenA, tokenB]) => {
          if (tokenA !== undefined && tokenB !== undefined) {
            return list.concat(
              tickSpacingList.map((tickspacing) => [
                tokenA,
                tokenB,
                tickspacing,
              ]),
            )
          }
          return []
        },
        [],
      )

    const filtered: [Token, Token, number][] = []
    allCurrencyCombinationsWithAllTickSpacings.forEach(
      ([currencyA, currencyB, tickSpacing]) => {
        if (currencyA && currencyB && tickSpacing) {
          const tokenA = currencyA.wrapped
          const tokenB = currencyB.wrapped
          if (tokenA.equals(tokenB)) return
          filtered.push(
            tokenA.sortsBefore(tokenB)
              ? [tokenA, tokenB, tickSpacing]
              : [tokenB, tokenA, tickSpacing],
          )
        }
      },
    )
    return filtered.map(([currencyA, currencyB, tickSpacing]) => ({
      address: this.computeShadowV3PoolAddress(
        currencyA.wrapped,
        currencyB.wrapped,
        tickSpacing,
      ) as Address,
      token0: currencyA,
      token1: currencyB,
      fee: SHADOW_V3_TICK_SPACING_MAP[tickSpacing]!,
    }))
  }

  computeShadowV3PoolAddress(
    tokenA: Token,
    tokenB: Token,
    tickSpacing: number,
  ): Address {
    const [token0, token1] = tokenA.sortsBefore(tokenB)
      ? [tokenA, tokenB]
      : [tokenB, tokenA]
    return getCreate2Address(
      this.factory[this.chainId as keyof typeof this.factory]!,
      keccak256(
        ['bytes'],
        [
          defaultAbiCoder.encode(
            ['address', 'address', 'uint24'],
            [token0.address, token1.address, tickSpacing],
          ),
        ],
      ),
      this.initCodeHash[this.chainId as keyof typeof this.initCodeHash]!,
    ) as Address
  }

  override async ensureFeeAndTicks(): Promise<boolean> {
    const tickSpacingList = Object.values(this.TICK_SPACINGS).filter(
      (v) => typeof v === 'number',
    )
    const results = (await this.client.multicall({
      multicallAddress: this.client.chain?.contracts?.multicall3
        ?.address as Address,
      allowFailure: false,
      contracts: tickSpacingList.map(
        (tickSpacing) =>
          ({
            chainId: this.chainId,
            address: this.mainFactory[
              this.chainId as keyof typeof this.mainFactory
            ]! as Address,
            abi: [
              {
                inputs: [
                  { internalType: 'int24', name: 'tickSpacing', type: 'int24' },
                ],
                name: 'tickSpacingInitialFee',
                outputs: [
                  {
                    internalType: 'uint24',
                    name: 'initialFee',
                    type: 'uint24',
                  },
                ],
                stateMutability: 'view',
                type: 'function',
              },
            ],
            functionName: 'tickSpacingInitialFee',
            args: [tickSpacing],
          }) as const,
      ),
    })) as number[]

    return results.every(
      (v, i) =>
        this.TICK_SPACINGS[v as ShadowV3FeeAmount] === tickSpacingList[i],
    )
  }
}
