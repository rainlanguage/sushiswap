import { Address, Log, parseAbiItem, parseEventLogs } from 'viem'
import { Token } from '../../currency/index.js'
import { RainDataFetcherOptions } from '../rain/RainDataFetcher.js'
import { RainV3Pool } from '../rain/UniswapV3Base.js'
import { AlgebraIntegralV1BaseProvider } from './AlgebraIntegralV1Base.js'
import { PoolFilter } from './UniswapV3Base.js'

const pluginAbi = [
  {
    inputs: [],
    name: 'plugin',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

const getCurrentFeeAbi = [
  {
    inputs: [],
    name: 'getCurrentFee',
    outputs: [{ internalType: 'uint16', name: 'fee', type: 'uint16' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

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

// integral 1.2 pool with its plugin address, undefined until the first
// successful read, the zero address marks a pool without a plugin
export interface AlgebraIntegralV1_2Pool extends RainV3Pool {
  plugin?: Address
}

export abstract class AlgebraIntegralV1_2BaseProvider extends AlgebraIntegralV1BaseProvider {
  override eventsAbi = AlgebraIntegralV1_2EventsAbi
  // used for pools that need reserve refetch upon swap with non zero plugin fee
  onSwapPluginFeeUpdatePools: RainV3Pool[] = []

  override async fetchPoolData(
    t0: Token,
    t1: Token,
    excludePools?: Set<string> | PoolFilter,
    options?: RainDataFetcherOptions,
  ): Promise<RainV3Pool[]> {
    const pools = await super.fetchPoolData(t0, t1, excludePools, options)
    if (pools.length === 0) return pools
    await this.updatePluginFees(pools, options?.blockNumber)
    return pools
  }

  /**
   * Updates the fees of the given pools from their plugin's getCurrentFee()
   * view. A dynamic fee plugin (eg hydrex) recalculates the fee at every
   * swap, while globalState.lastFee only reports the fee of the last swap,
   * so the plugin view carries the fee the next swap will actually pay.
   * Pools without a plugin, or with a plugin lacking the view, keep their
   * current fee
   */
  async updatePluginFees(
    pools: AlgebraIntegralV1_2Pool[],
    blockNumber?: bigint,
  ) {
    const unknown = pools.filter((pool) => pool.plugin === undefined)
    if (unknown.length) {
      const plugins = await this.client
        .multicall({
          multicallAddress: this.client.chain?.contracts?.multicall3?.address!,
          allowFailure: true,
          blockNumber,
          contracts: unknown.map(
            (pool) =>
              ({
                address: pool.address as Address,
                chainId: this.chainId,
                abi: pluginAbi,
                functionName: 'plugin',
              }) as const,
          ),
        })
        .catch(() => undefined)
      if (plugins) {
        unknown.forEach((pool, i) => {
          const plugin = plugins[i]?.result
          if (typeof plugin === 'string') {
            pool.plugin = plugin
          }
        })
      }
    }

    const feePools = pools.filter(
      (pool) =>
        typeof pool.plugin === 'string' &&
        pool.plugin !== '0x0000000000000000000000000000000000000000',
    )
    if (feePools.length === 0) return

    const fees = await this.client
      .multicall({
        multicallAddress: this.client.chain?.contracts?.multicall3?.address!,
        allowFailure: true,
        blockNumber,
        contracts: feePools.map(
          (pool) =>
            ({
              address: pool.plugin!,
              chainId: this.chainId,
              abi: getCurrentFeeAbi,
              functionName: 'getCurrentFee',
            }) as const,
        ),
      })
      .catch(() => undefined)
    if (!fees) return

    feePools.forEach((pool, i) => {
      const fee = fees[i]?.result
      if (typeof fee === 'number') pool.fee = fee
    })
  }

  override async afterProcessLog(untilBlock: bigint) {
    // refresh the dynamic fees of all cached pools, the fee for the next
    // swap drifts with volatility even when no event fires
    const pluginFeesPromise = this.updatePluginFees(
      [...this.pools.values()],
      untilBlock,
    )
    const reservesPromise = this.getReserves(this.onSwapPluginFeeUpdatePools, {
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
    await pluginFeesPromise
    for (let i = 0; i < this.onSwapPluginFeeUpdatePools.length; i++) {
      const pool = this.onSwapPluginFeeUpdatePools[i]
      const reserve = reserves[i]
      if (!pool) continue
      if (typeof reserve !== 'undefined') {
        pool.reserve0 = reserve[0]!
        pool.reserve1 = reserve[1]!
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
              // a plugin can override the pool fee per swap (eg hydrex does
              // this on every swap) without ever writing it back to
              // globalState, so the event carries the only accurate fee
              const feeChanged =
                typeof overrideFee === 'number' &&
                overrideFee > 0 &&
                overrideFee !== pool.fee
              if (feeChanged) {
                pool.fee = overrideFee as number
              }
              if (tick !== undefined) {
                pool.tick = tick
                pool.activeTick =
                  Math.floor(tick / pool.tickSpacing) * pool.tickSpacing
              }
              // refetch balances when the plugin took an extra fee or
              // changed the pool fee, those swaps move amounts that the
              // event does not report, tick data never drifts that way so
              // it always updates through the incremental tick words below
              if (
                (typeof pluginFee === 'number' && pluginFee > 0) ||
                feeChanged
              ) {
                const onSwapPoolExists = this.onSwapPluginFeeUpdatePools.find(
                  (v) => v.address.toLowerCase() === pool.address.toLowerCase(),
                )
                if (!onSwapPoolExists) {
                  this.onSwapPluginFeeUpdatePools.push(pool)
                }
              }
              if (tick !== undefined) {
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
            break
          }
          default: {
            this.otherEventCases(log, event, pool)
          }
        }
      } catch {}
    }
  }
}
