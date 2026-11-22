import type { Address } from 'viem'
import type { CLTick } from './CLPool.js'
import type { RToken } from './RPool.js'
import { UniV3Pool } from './UniV3Pool.js'

const two96 = 2 ** 96

/**
 * A Uniswap V4 pool, the swap math is the one of UniV3Pool. Every V4 pool
 * lives in one PoolManager contract, the pool's address, so the pool is told
 * by its id. The PoolManager holds the tokens of every pool, so the reserves
 * are the virtual reserves of the current liquidity and price, L / sqrtP and
 * L * sqrtP, they are zero when no position covers the current tick
 */
export class UniV4Pool extends UniV3Pool {
  id: string
  hooks: Address

  /// @param id The pool id, keccak256 of the abi encoded PoolKey
  /// @param address The address of the PoolManager
  /// @param token0 The first token of the pool, the native token has the address ''
  /// @param token1 The second token of the pool
  /// @param fee Pool's swap fee in fractions of 1. fee=0.003 means 0.3%
  /// @param hooks The hooks address of the pool
  /// @param activeTick The current tick rounded down to the tick spacing
  /// @param liquidity Current pool liquidity
  /// @param sqrtPriceX96 Square root of the current pool price multiplied 2^96
  /// @param ticks The list of all initialized ticks, sorted by index from low to high
  /// @param nearestTick (optional) The index in ticks of the nearest tick below the price
  /// @param tick (optional) The current tick
  constructor(
    id: string,
    address: Address,
    token0: RToken,
    token1: RToken,
    fee: number,
    hooks: Address,
    activeTick: number,
    liquidity: bigint,
    sqrtPriceX96: bigint,
    ticks: CLTick[],
    nearestTick?: number,
    tick?: number,
  ) {
    super(
      address,
      token0,
      token1,
      fee,
      0n,
      0n,
      activeTick,
      liquidity,
      sqrtPriceX96,
      ticks,
      nearestTick,
      tick,
    )
    this.id = id
    this.hooks = hooks
    // a deserialized pool gets its state after the constructor
    if (typeof sqrtPriceX96 === 'bigint' && sqrtPriceX96 > 0n) {
      const sqrtPrice = Number(sqrtPriceX96) / two96
      const reserve0 = Number(liquidity) / sqrtPrice
      const reserve1 = Number(liquidity) * sqrtPrice
      this.reserve0 = BigInt(Math.floor(reserve0))
      this.reserve1 = BigInt(Math.floor(reserve1))
    }
  }

  // the reserves are derived from the state, they are not set from outside
  override updateReserves() {
    throw new Error("Function UniV4Pool.updateReserves shouldn't be called")
  }

  override updateState() {
    throw new Error("Function UniV4Pool.updateState shouldn't be called")
  }

  // every V4 pool has the address of the PoolManager
  override uniqueID(): string {
    return this.id + this.address
  }
}
