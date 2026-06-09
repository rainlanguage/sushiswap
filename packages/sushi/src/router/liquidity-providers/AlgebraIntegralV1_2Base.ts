import { Log, parseAbiItem, parseEventLogs } from 'viem'
import { CLTick } from '../../tines/CLPool.js'
import { RainDataFetcherOptions } from '../rain/RainDataFetcher.js'
import { RainV3Pool } from '../rain/UniswapV3Base.js'
import { AlgebraIntegralV1BaseProvider } from './AlgebraIntegralV1Base.js'
import { NUMBER_OF_SURROUNDING_TICKS } from './UniswapV3Base.js'

export const AlgebraIntegralV1_2EventsAbi = [
  parseAbiItem(
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 overrideFee, uint24 pluginFee)',
  ),
  parseAbiItem(
    'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  ),
  parseAbiItem(
    'event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)',
  ),
  parseAbiItem(
    'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1, uint24 pluginFee)',
  ),
  parseAbiItem(
    'event Flash(address indexed sender, address indexed recipient, uint256 amount0, uint256 amount1, uint256 paid0, uint256 paid1)',
  ),
  parseAbiItem('event Fee(uint16 fee)'),
  parseAbiItem('event TickSpacing(int24 newTickSpacing)'),
  parseAbiItem(
    'event Pool(address indexed token0, address indexed token1, address pool)',
  ),
]

export abstract class AlgebraIntegralV1_2BaseProvider extends AlgebraIntegralV1BaseProvider {
  override eventsAbi = AlgebraIntegralV1_2EventsAbi
  // used for pools that need reserve refetch upon swap with non zero plugin fee
  onSwapPluginFeeUpdatePools: RainV3Pool[] = []

  override async afterProcessLog(untilBlock: bigint) {
    const reservesPromise = this.getReserves(this.onSwapPluginFeeUpdatePools, {
      blockNumber: untilBlock,
    })
    const ticksPromise = this.getTicks(this.onSwapPluginFeeUpdatePools, {
      blockNumber: untilBlock,
    })
    const newTicksQueue = [...this.newTicksQueue.splice(0)]
    if (newTicksQueue.length) {
      const newTicks = await this.getTicksInner(newTicksQueue, {
        blockNumber: untilBlock,
      })
      if (newTicks) {
        newTicksQueue.forEach(([pool], i) => {
          newTicks?.[i]?.forEach((newTick, index) => {
            pool.ticks.set(index, newTick)
          })
        })
      } else {
        // if unsuccessfull to get new ticks, put them back on queue for next try
        this.newTicksQueue.push(...newTicksQueue)
      }
    }
    const reserves = await reservesPromise
    const ticks = await ticksPromise
    for (let i = 0; i < this.onSwapPluginFeeUpdatePools.length; i++) {
      const pool = this.onSwapPluginFeeUpdatePools[i]
      const reserve = reserves[i]
      const tick = ticks?.[i]
      if (!pool) continue
      if (typeof reserve !== 'undefined') {
        pool.reserve0 = reserve[0]!
        pool.reserve1 = reserve[1]!
      }
      if (typeof tick !== 'undefined') {
        pool.ticks = tick
      }
    }
    this.onSwapPluginFeeUpdatePools = []
  }

  /**
   * Handles pool events and updates the pool cache with the results
   */
  override handlePoolEvents(log: Log) {
    const logAddress = log.address.toLowerCase()
    const pool = this.pools.get(logAddress)
    if (pool) {
      try {
        const event = parseEventLogs({ logs: [log], abi: this.eventsAbi })[0]!
        switch (event.eventName) {
          case 'Mint': {
            const { amount, amount0, amount1 } = event.args
            const { tickLower, tickUpper } = event.args
            if (log.blockNumber! >= pool.blockNumber) {
              pool.blockNumber = log.blockNumber!
              if (
                tickLower !== undefined &&
                tickUpper !== undefined &&
                amount !== undefined
              ) {
                const tick = pool.activeTick
                if (tickLower <= tick && tick < tickUpper)
                  pool.liquidity += amount
              }
              if (amount1 !== undefined && amount0 !== undefined) {
                pool.reserve0 += amount0
                pool.reserve1 += amount1
              }
              if (
                tickLower !== undefined &&
                tickUpper !== undefined &&
                amount !== undefined
              ) {
                this.addTick(tickLower, amount, pool)
                this.addTick(tickUpper, -amount, pool)
              }
            }
            break
          }
          case 'Burn': {
            const { amount } = event.args
            const { tickLower, tickUpper } = event.args
            if (log.blockNumber! >= pool.blockNumber) {
              pool.blockNumber = log.blockNumber!
              if (
                tickLower !== undefined &&
                tickUpper !== undefined &&
                amount !== undefined
              ) {
                const tick = pool.activeTick
                if (tickLower <= tick && tick < tickUpper)
                  pool.liquidity -= amount
              }
              if (
                tickLower !== undefined &&
                tickUpper !== undefined &&
                amount !== undefined
              ) {
                this.addTick(tickLower, -amount, pool)
                this.addTick(tickUpper, amount, pool)
              }
            }
            break
          }
          case 'Collect': {
            if (log.blockNumber! >= pool.blockNumber) {
              pool.blockNumber = log.blockNumber!
              const { amount0, amount1 } = event.args
              if (amount0 !== undefined && amount1 !== undefined) {
                pool.reserve0 -= amount0
                pool.reserve1 -= amount1
              }
            }
            break
          }
          case 'Flash': {
            if (log.blockNumber! >= pool.blockNumber) {
              pool.blockNumber = log.blockNumber!
              const { paid0, paid1 } = event.args
              if (paid0 !== undefined && paid1 !== undefined) {
                pool.reserve0 += paid0
                pool.reserve1 += paid1
              }
            }
            break
          }
          case 'Swap': {
            if (log.blockNumber! >= pool.blockNumber) {
              pool.blockNumber = log.blockNumber!
              const {
                amount0,
                amount1,
                sqrtPriceX96,
                liquidity,
                tick,
                pluginFee,
                overrideFee,
              } = event.args
              if (amount0 !== undefined && amount1 !== undefined) {
                pool.reserve0 += amount0
                pool.reserve1 += amount1
              }
              if (sqrtPriceX96 !== undefined) pool.sqrtPriceX96 = sqrtPriceX96
              if (liquidity !== undefined) pool.liquidity = liquidity
              // need to refecth balance if there custom fee on swap
              const onSwapPoolExists = this.onSwapPluginFeeUpdatePools.find(
                (v) => v.address.toLowerCase() === pool.address.toLowerCase(),
              )
              if (pluginFee > 0n || overrideFee > 0n) {
                if (!onSwapPoolExists) {
                  this.onSwapPluginFeeUpdatePools.push(pool)
                  const index = this.newTicksQueue.findIndex(
                    (v) => v[0].address === pool.address,
                  )
                  if (index > -1) {
                    this.newTicksQueue.splice(index, 1)
                  }
                }
                if (tick !== undefined) {
                  pool.tick = tick
                  pool.activeTick =
                    Math.floor(tick / pool.tickSpacing) * pool.tickSpacing
                }
              } else if (tick !== undefined) {
                if (!onSwapPoolExists) {
                  pool.tick = tick
                  pool.activeTick =
                    Math.floor(tick / pool.tickSpacing) * pool.tickSpacing
                  const newTicks = this.onPoolTickChange(pool.activeTick, pool)
                  const queue = this.newTicksQueue.find(
                    (v) => v[0].address === pool.address,
                  )
                  if (queue) {
                    for (const t of newTicks) {
                      if (!queue[1].includes(t)) queue[1].push(t)
                    }
                  } else {
                    this.newTicksQueue.push([pool, newTicks])
                  }
                }
              }
            }
            break
          }
          default: {
            this.otherEventCases(log, event, pool)
          }
        }
      } catch {}
    }
  }

  /**
   * Calculates and returns the list of current ticks for the given pool
   */
  override getMaxTickDiapason(tick: number, pool: RainV3Pool): CLTick[] {
    const currentTickIndex = bitmapIndex(tick, pool.tickSpacing)
    if (!pool.ticks.has(currentTickIndex)) return []
    let minIndex
    let maxIndex
    for (minIndex = currentTickIndex; pool.ticks.has(minIndex); --minIndex);
    for (maxIndex = currentTickIndex + 1; pool.ticks.has(maxIndex); ++maxIndex);
    if (maxIndex - minIndex <= 1) return []

    let poolTicks: CLTick[] = []
    for (let i = minIndex + 1; i < maxIndex; ++i)
      poolTicks = poolTicks.concat(pool.ticks.get(i)!)

    const lowerUnknownTick = (minIndex + 1) * 256 - 1
    console.assert(
      poolTicks.length === 0 || lowerUnknownTick < poolTicks[0]!.index,
      'Error 236: unexpected min tick index',
    )
    poolTicks.unshift({
      index: lowerUnknownTick,
      DLiquidity: 0n,
    })
    const upperUnknownTick = maxIndex * 256
    console.assert(
      poolTicks[poolTicks.length - 1]!.index < upperUnknownTick,
      'Error 244: unexpected max tick index',
    )
    poolTicks.push({
      index: upperUnknownTick,
      DLiquidity: 0n,
    })

    return poolTicks
  }

  /**
   * Fetches ticks capped at pool boundries of the given list of pools
   */
  override async getTicks(
    existingPools: RainV3Pool[],
    options?: RainDataFetcherOptions,
  ): Promise<Map<number, CLTick[]>[] | undefined> {
    const [minIndexes, maxIndexes] = this.getIndexes(existingPools)
    const wordList = existingPools.map((pool, i) => {
      const minIndex = minIndexes[i]!
      const maxIndex = maxIndexes[i]!

      return [
        pool,
        Array.from({ length: maxIndex - minIndex + 1 }, (_, i) => minIndex + i),
      ] as [RainV3Pool, number[]]
    })
    return await this.getTicksInner(wordList, options)
  }

  override getIndexes(existingPools: RainV3Pool[]): [number[], number[]] {
    const minIndexes = existingPools.map((pool) =>
      bitmapIndex(
        pool.activeTick - NUMBER_OF_SURROUNDING_TICKS,
        pool.tickSpacing,
      ),
    )
    const maxIndexes = existingPools.map((pool) =>
      bitmapIndex(
        pool.activeTick + NUMBER_OF_SURROUNDING_TICKS,
        pool.tickSpacing,
      ),
    )
    return [minIndexes, maxIndexes]
  }
}

export const bitmapIndex = (tick: number, _tickSpacing: number) => {
  return Math.floor(tick / 256)
}
