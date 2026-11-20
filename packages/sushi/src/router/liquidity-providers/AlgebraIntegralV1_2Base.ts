import { Address, Log, parseAbiItem, parseEventLogs } from 'viem'
import { Token } from '../../currency/index.js'
import { RainDataFetcherOptions } from '../rain/RainDataFetcher.js'
import { RainV3Pool } from '../rain/UniswapV3Base.js'
import { AlgebraIntegralV1BaseProvider } from './AlgebraIntegralV1Base.js'
import { PoolFilter } from './UniswapV3Base.js'

/**
 * a balance read in flight, see afterProcessLog: the balance changes of the
 * logs applied to its pools while it runs, past the block it is pinned to,
 * added back on top of the balances it brings, which replace the live ones
 */
interface ReserveRead {
  /** the block the read is pinned to, a log at or before it is inside the read */
  block: bigint
  /** the lowercase addresses of the pools the read fetches balances for */
  pools: Set<string>
  /** the balance deltas to add back, by lowercase pool address */
  deltas: Map<string, [bigint, bigint]>
}

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
  /** the balance reads in flight, see afterProcessLog and handlePoolEvents */
  reserveReads = new Set<ReserveRead>()
  /** the block of the newest plugin fee round that landed, bookkeeping, the per pool blocks guard, see updatePluginFees */
  pluginFeeRoundBlock = -1n
  /** the block of the newest plugin fee round that set each pool's fee, lowercase address, a round covers the pools it was asked for only, an older one landing late sets nothing, see updatePluginFees */
  pluginFeeBlocks = new Map<string, bigint>()
  /** the block of the newest balance read that landed per pool, lowercase address, an older one landing late is dropped, see afterProcessLog */
  reserveReadBlock = new Map<string, bigint>()

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
    round = false,
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
    // two rounds in flight can land in either order, the fees are of the
    // block they were read at, so an older round landing last sets nothing.
    // The rounds cover different pools, so the newest round is kept per
    // pool. A fetch reads the fees of pools no round had yet, at the block
    // the fetch is pinned to, which may be behind the rounds, it is no round
    const guarded = round && blockNumber !== undefined
    if (guarded && blockNumber > this.pluginFeeRoundBlock) {
      this.pluginFeeRoundBlock = blockNumber
    }
    feePools.forEach((pool, i) => {
      const fee = fees[i]?.result
      if (typeof fee !== 'number') return
      if (guarded) {
        const address = pool.address.toLowerCase()
        const newest = this.pluginFeeBlocks.get(address)
        if (newest !== undefined && blockNumber < newest) return
        this.pluginFeeBlocks.set(address, blockNumber)
      }
      pool.fee = fee
    })
  }

  override async afterProcessLog(untilBlock: bigint, scope?: Set<string>) {
    // refresh the dynamic fees of the cached pools, the fee for the next
    // swap drifts with volatility even when no event fires, kept to the
    // pools a log touched when a scope is given. pools cached ahead of
    // untilBlock take no part in this round
    const feePools = [...this.pools.values()].filter(
      (pool) =>
        pool.blockNumber <= untilBlock &&
        (scope === undefined || scope.has(pool.address.toLowerCase())),
    )
    // the pools whose balances a plugin fee moved, taken for this round,
    // the ones a later log adds wait for the next round, and so does a pool
    // ahead of the round, a balance read at this block would miss the log
    // that moved it past it
    const reservePools = this.onSwapPluginFeeUpdatePools.filter(
      (pool) => pool.blockNumber <= untilBlock,
    )
    this.onSwapPluginFeeUpdatePools = this.onSwapPluginFeeUpdatePools.filter(
      (pool) => pool.blockNumber > untilBlock,
    )
    // no fee and no balance to read, only the tick words of the base are
    // left, if any
    if (!feePools.length && !reservePools.length)
      return super.afterProcessLog(untilBlock, scope)

    const pluginFeesPromise = feePools.length
      ? this.updatePluginFees(feePools, untilBlock, true)
      : undefined
    // the logs that arrive while the balances are read keep applying, their
    // balance changes are added back on top of the read once it lands, the
    // read replaces the live balances, see handlePoolEvents
    const read: ReserveRead = {
      block: untilBlock,
      pools: new Set(reservePools.map((pool) => pool.address.toLowerCase())),
      deltas: new Map(),
    }
    this.reserveReads.add(read)
    let reserves: ([bigint, bigint] | undefined)[]
    try {
      const reservesPromise = this.getReserves(reservePools, {
        blockNumber: untilBlock,
      })
      // the tick words a Swap queued, the base reads them
      await super.afterProcessLog(untilBlock, scope)
      reserves = await reservesPromise
      await pluginFeesPromise
    } finally {
      this.reserveReads.delete(read)
    }
    reservePools.forEach((pool, i) => {
      const reserve = reserves[i]
      if (typeof reserve === 'undefined') {
        // the read failed, the pool waits for the next round
        this.queueReserveRead(pool)
        return
      }
      const address = pool.address.toLowerCase()
      // two reads of one pool in flight can land in either order, the
      // older one landing last would undo the drift the newer one read
      const newest = this.reserveReadBlock.get(address)
      if (newest !== undefined && newest > read.block) return
      this.reserveReadBlock.set(address, read.block)
      const delta = read.deltas.get(address)
      pool.reserve0 = reserve[0]! + (delta?.[0] ?? 0n)
      pool.reserve1 = reserve[1]! + (delta?.[1] ?? 0n)
    })
  }

  /**
   * Queues a balance read of the pool for the next round, once, a plugin fee
   * moved its balances in a way the logs do not tell, see afterProcessLog
   */
  queueReserveRead(pool: RainV3Pool) {
    const address = pool.address.toLowerCase()
    const queued = this.onSwapPluginFeeUpdatePools.some(
      (v) => v.address.toLowerCase() === address,
    )
    if (!queued) this.onSwapPluginFeeUpdatePools.push(pool)
  }

  /**
   * Handles pool events and updates the pool cache with the results. A
   * balance read in flight for the pool that is pinned before the log's block
   * takes the log's balance change as well, the balances it brings back
   * replace the live ones, so the change is added back once it lands, see
   * afterProcessLog
   */
  override handlePoolEvents(log: Log) {
    const pool = this.pools.get(log.address.toLowerCase())
    const before: [bigint, bigint] | undefined = pool
      ? [pool.reserve0, pool.reserve1]
      : undefined
    this.applyPoolEvent(log)
    if (!pool || !before || !this.reserveReads.size) return
    const block = log.blockNumber
    if (block === null) return
    const delta0 = pool.reserve0 - before[0]
    const delta1 = pool.reserve1 - before[1]
    if (delta0 === 0n && delta1 === 0n) return
    const address = pool.address.toLowerCase()
    this.reserveReads.forEach((read) => {
      if (!read.pools.has(address) || block <= read.block) return
      const sum = read.deltas.get(address) ?? [0n, 0n]
      read.deltas.set(address, [sum[0] + delta0, sum[1] + delta1])
    })
  }

  /** Applies one pool event to the pool cache, see handlePoolEvents */
  private applyPoolEvent(log: Log) {
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
                this.addTick(tickLower, amount, pool, log.blockNumber!)
                this.addTick(tickUpper, -amount, pool, log.blockNumber!)
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
                this.addTick(tickLower, -amount, pool, log.blockNumber!)
                this.addTick(tickUpper, amount, pool, log.blockNumber!)
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
                this.queueReserveRead(pool)
              }
              if (tick !== undefined) this.queueNewTicks(pool)
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
