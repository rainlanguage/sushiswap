import { add, getUnixTime } from 'date-fns'
import {
  Address,
  Hex,
  PublicClient,
  encodePacked,
  getAddress,
  keccak256,
} from 'viem'
import { ChainId } from '../../chain/index.js'
import { Token } from '../../currency/Token.js'
import { ConstantProductRPool } from '../../tines/PrimaryPools.js'
import { RToken } from '../../tines/RPool.js'
import { DataFetcherOptions } from '../data-fetcher.js'
import { getCurrencyCombinations } from '../get-currency-combinations.js'
import { ConstantProductPoolCode } from '../pool-codes/ConstantProductPool.js'
import { PoolCode } from '../pool-codes/PoolCode.js'
import { StaticPool, UniswapV2BaseProvider } from './UniswapV2Base.js'

export const getReservesAbi = [
  {
    inputs: [],
    name: 'getReserves',
    outputs: [
      {
        internalType: 'uint256',
        name: '_reserve0',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: '_reserve1',
        type: 'uint256',
      },
      {
        internalType: 'uint256',
        name: '_blockTimestampLast',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const getFeeAbi = [
  {
    inputs: [
      { internalType: 'address', name: 'pool', type: 'address' },
      { internalType: 'bool', name: '_stable', type: 'bool' },
    ],
    name: 'getFee',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/**
 * Velodrome V2 pool interface, has "stable" prop on top of original univ2 pool
 */
export interface VelodromeV2Pool extends StaticPool {
  stable: boolean
}

/**
 * Base abstract Velodrome V2 protocol provider class for dexes that are of this type to inherit from
 */
export abstract class VelodromeV2BaseProvider extends UniswapV2BaseProvider {
  override getReservesAbi = getReservesAbi

  stableFee = 0.0005
  volatileFee = 0.003
  poolImplementation: Record<number, Address> = {}

  constructor(
    chainId: ChainId,
    web3Client: PublicClient,
    factory: Record<number, Address>,
    poolImplementation: Record<number, Address>,
  ) {
    super(chainId, web3Client, factory, { [chainId]: `0x${'0'.repeat(64)}` })

    this.poolImplementation = poolImplementation
    if (!(chainId in this.poolImplementation)) {
      throw new Error(
        `${this.getType()} cannot be instantiated for chainid ${chainId}, no pool implementation address`,
      )
    }
  }

  override async getOnDemandPools(
    t0: Token,
    t1: Token,
    excludePools?: Set<string>,
    options?: DataFetcherOptions,
  ): Promise<void> {
    let pools = this.getStaticPools(t0, t1)
    if (excludePools)
      pools = (pools as VelodromeV2Pool[]).filter(
        (p) => !excludePools.has(p.address),
      )

    if (pools.length === 0) {
      return
    }

    this.poolsByTrade.set(
      this.getTradeId(t0, t1),
      pools.map((pool) => pool.address),
    )
    const validUntilTimestamp = getUnixTime(
      add(Date.now(), { seconds: this.ON_DEMAND_POOLS_LIFETIME_IN_SECONDS }),
    )

    const fees = await this.getPoolFee(pools, options)
    if (!fees) return

    const poolCodesToCreate: PoolCode[] = []
    pools.forEach((pool, i) => {
      const fee = fees[i]?.result
      const existingPool = this.onDemandPools.get(pool.address)
      if (existingPool === undefined) {
        const token0 = pool.token0 as RToken
        const token1 = pool.token1 as RToken

        const rPool = new ConstantProductRPool(
          pool.address,
          token0,
          token1,
          fee ?? 'fee' in pool ? pool.fee : this.fee,
          0n,
          0n,
        )
        const pc = new ConstantProductPoolCode(
          rPool,
          this.getType(),
          this.getPoolProviderName(),
        )
        poolCodesToCreate.push(pc)
      } else {
        existingPool.validUntilTimestamp = validUntilTimestamp
      }
    })

    const reserves = await this.getReserves(poolCodesToCreate, options)
    this.handleCreatePoolCode(
      poolCodesToCreate,
      reserves as any,
      validUntilTimestamp,
    )
  }

  override getStaticPools(t1: Token, t2: Token): VelodromeV2Pool[] {
    const currencyCombination = getCurrencyCombinations(
      this.chainId,
      t1,
      t2,
    ).map(([c0, c1]) => (c0.sortsBefore(c1) ? [c0, c1] : [c1, c0]))
    return currencyCombination.flatMap((combination) => [
      {
        address: computeVelodromeV2PoolAddress(
          this.factory[this.chainId as keyof typeof this.factory]!,
          this.poolImplementation[
            this.chainId as keyof typeof this.poolImplementation
          ]!,
          combination[0]!,
          combination[1]!,
          true,
        ),
        token0: combination[0]!,
        token1: combination[1]!,
        fee: this.stableFee,
        stable: true,
      },
      {
        address: computeVelodromeV2PoolAddress(
          this.factory[this.chainId]!,
          this.poolImplementation[this.chainId]!,
          combination[0]!,
          combination[1]!,
          false,
        ),
        token0: combination[0]!,
        token1: combination[1]!,
        fee: this.volatileFee,
        stable: false,
      },
    ])
  }

  override async getReserves(
    poolCodesToCreate: PoolCode[],
    options?: DataFetcherOptions,
  ) {
    return await this.client
      .multicall({
        multicallAddress: this.client.chain?.contracts?.multicall3
          ?.address as Address,
        allowFailure: true,
        blockNumber: options?.blockNumber,
        contracts: poolCodesToCreate.map(
          (poolCode) =>
            ({
              address: poolCode.pool.address as Address,
              chainId: this.chainId,
              abi: this.getReservesAbi,
              functionName: 'getReserves',
            }) as const,
        ),
      })
      .catch((e) => {
        console.warn(
          `${this.getLogPrefix()} - UPDATE: on-demand pools multicall failed, message: ${
            e.message
          }`,
        )
        return undefined
      })
  }

  async getPoolFee(pools: VelodromeV2Pool[], options?: DataFetcherOptions) {
    return await this.client
      .multicall({
        multicallAddress: this.client.chain?.contracts?.multicall3
          ?.address as Address,
        allowFailure: true,
        blockNumber: options?.blockNumber,
        contracts: pools.map((p) => ({
          address: this.factory[
            this.chainId as keyof typeof this.factory
          ]! as Address,
          chainId: this.chainId,
          abi: getFeeAbi,
          functionName: 'getFee',
          args: [p.address, p.stable],
        })),
      })
      .catch((e) => {
        console.warn(
          `${this.getLogPrefix()} - UPDATE: getting pools fees multicall failed, message: ${
            e.message
          }`,
        )
        return undefined
      })
  }
}

/**
 * Computes Velodrome V2 pool address from the given factory, pool impl, tokens and stable
 */
export function computeVelodromeV2PoolAddress(
  factory: Address,
  impl: Address,
  tokenA: Token,
  tokenB: Token,
  stable: boolean,
): Address {
  const [token0, token1] = tokenA.sortsBefore(tokenB)
    ? [tokenA, tokenB]
    : [tokenB, tokenA]
  const constructorArgumentsEncoded = encodePacked(
    ['address', 'address', 'bool'],
    [token0.address, token1.address, stable],
  )
  // Velodrome V2 doesnt have classic initcode hash, it uses openzeppelin Clone contract instead
  const initCode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl!.replace(
    '0x',
    '',
  )}5af43d82803e903d91602b57fd5bf3` as Hex
  const initCodeHash = keccak256(initCode)
  const create2Inputs = [
    '0xff',
    factory,
    // salt
    keccak256(constructorArgumentsEncoded),
    // init code hash
    initCodeHash,
  ]
  const sanitizedInputs = `0x${create2Inputs
    .map((i) => i.slice(2))
    .join('')}` as Hex
  return getAddress(`0x${keccak256(sanitizedInputs).slice(-40)}`)
}
