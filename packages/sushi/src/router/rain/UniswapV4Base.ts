import {
  type Hex,
  type Log,
  formatLog,
  numberToHex,
  parseAbiItem,
  parseEventLogs,
  toEventSelector,
} from 'viem'
import type { Token } from '../../currency/index.js'
import { bitmapIndex } from '../liquidity-providers/UniswapV3Base.js'
import {
  UniswapV4BaseProvider as _UniswapV4BaseProvider,
  type UniswapV4PoolState,
  type UniswapV4StaticPool,
  uniswapV4SwapFee,
} from '../liquidity-providers/UniswapV4Base.js'
import type { RainDataFetcherOptions } from './RainDataFetcher.js'
import { type TickRead, addTickTo, mergeTickDeltas } from './UniswapV3Base.js'

/** the PoolManager events that change the state of a pool, or tell it exists */
export const UniswapV4EventsAbi = [
  parseAbiItem(
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  ),
  parseAbiItem(
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  ),
  parseAbiItem(
    'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  ),
  parseAbiItem(
    'event ProtocolFeeUpdated(bytes32 indexed id, uint24 protocolFee)',
  ),
] as const

/**
 * The Uniswap V4 provider of RainDataFetcher. With ignoreCache false a fetch
 * reads only the pools it has not read yet, and a pool id that was read with
 * no pool more than once is not read again, until an Initialize log tells
 * the pool exists. The PoolManager is read as a factory is, for its
 * Initialize logs, see eventsAbi. The pools are kept current by the
 * PoolManager logs, the pool a log is about is its id in topic 1: a Swap
 * sets the price, the tick and the liquidity, a ModifyLiquidity changes the
 * liquidity and the ticks, a ProtocolFeeUpdated the protocol fee. The tick
 * table words a swap moved the price to are read at afterProcessLog
 */
export abstract class UniswapV4BaseProvider extends _UniswapV4BaseProvider {
  /** the pool ids read with no pool, lowercase, and how many times */
  nullPools: Map<string, number> = new Map()
  /**
   * the events of the address based log read of a round, the Initialize
   * event: the PoolManager is in that read as a factory is. The logs of the
   * pools are read by pool id, see getPoolManagerLogs
   */
  eventsAbi = UniswapV4EventsAbi.filter((e) => e.name === 'Initialize')
  /** the PoolManager events this provider applies, see processLog */
  poolManagerEventsAbi = UniswapV4EventsAbi
  /** the tick table words to read for a pool at afterProcessLog */
  newTicksQueue: [UniswapV4PoolState, number[]][] = []
  /** the tick word reads in flight, see afterProcessLog and addTick */
  tickReads = new Set<TickRead>()
  /** the pool ids one PoolManager log read filters by at most, a node caps the values of one topic */
  logIdsPerRead = 500

  override selectPools(
    pools: UniswapV4StaticPool[],
    options?: RainDataFetcherOptions,
  ): UniswapV4StaticPool[] {
    // this ensures backward compatibility for original DataFetcher
    if (typeof options?.ignoreCache === 'boolean' && !options.ignoreCache)
      return this.filterCachedPools(pools)
    return pools
  }

  override onMissingPool(pool: UniswapV4StaticPool) {
    this.handleNullPool(pool.id)
  }

  /** The parent's scan, a pool its logs tell exists is not a null pool */
  override async getPoolsFromLogs(
    t0: Token,
    t1: Token,
    toBlock: bigint,
    extraPairs?: [Token, Token][],
  ): Promise<UniswapV4StaticPool[]> {
    const pools = await super.getPoolsFromLogs(t0, t1, toBlock, extraPairs)
    pools.forEach((pool) => this.nullPools.delete(pool.id))
    return pools
  }

  /** The lowercase id of the pool a PoolManager log is about, undefined for a log of another contract */
  poolKeyOfLog(log: {
    address: string
    topics: readonly (Hex | null)[]
  }): string | undefined {
    if (log.address.toLowerCase() !== this.getPoolManager().toLowerCase())
      return undefined
    return log.topics[1]?.toLowerCase() ?? undefined
  }

  /** topic0 of the PoolManager events of a pool that exists: Swap, ModifyLiquidity and ProtocolFeeUpdated */
  get updateTopics(): Hex[] {
    return this.poolManagerEventsAbi
      .filter((e) => e.name !== 'Initialize')
      .map((e) => toEventSelector(e))
  }

  /**
   * Reads the Swap, ModifyLiquidity and ProtocolFeeUpdated logs of the given
   * cached pools from fromBlock to toBlock, filtered by their ids in topic 1,
   * in chunks of logIdsPerRead ids. The Initialize logs come with the
   * factory logs, see eventsAbi. Throws when a read fails
   */
  async getPoolManagerLogs(
    ids: string[],
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Log[]> {
    const topics = this.updateTopics
    const read = (chunk: Hex[]) =>
      this.client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: this.getPoolManager(),
            topics: [topics, chunk],
            fromBlock: numberToHex(fromBlock),
            toBlock: numberToHex(toBlock),
          },
        ],
      })
    const reads: ReturnType<typeof read>[] = []
    for (let i = 0; i < ids.length; i += this.logIdsPerRead)
      reads.push(read(ids.slice(i, i + this.logIdsPerRead) as Hex[]))
    const results = await Promise.all(reads)
    return results.flat().map((log) => formatLog(log) as Log)
  }

  /**
   * Applies a PoolManager log to the cached pool it is about, a log older
   * than the pool's state is skipped
   * @returns true when an Initialize log tells a null pool exists
   */
  override processLog(log: Log): boolean {
    const id = this.poolKeyOfLog(log)
    if (id === undefined) return false
    let event
    try {
      event = parseEventLogs({ logs: [log], abi: this.poolManagerEventsAbi })[0]
    } catch {
      return false
    }
    if (!event) return false
    if (event.eventName === 'Initialize') return this.nullPools.delete(id)
    const pool = this.pools.get(id)
    const block = log.blockNumber
    if (!pool || block === null || block < pool.blockNumber) return false
    pool.blockNumber = block
    switch (event.eventName) {
      case 'Swap': {
        const { sqrtPriceX96, liquidity, tick } = event.args
        pool.sqrtPriceX96 = sqrtPriceX96
        pool.liquidity = liquidity
        pool.tick = tick
        pool.activeTick = Math.floor(tick / pool.tickSpacing) * pool.tickSpacing
        this.queueNewTicks(pool)
        break
      }
      case 'ModifyLiquidity': {
        const { tickLower, tickUpper, liquidityDelta } = event.args
        // the position is in range when the current tick is inside it, as v4-core Pool tells
        if (tickLower <= pool.tick && pool.tick < tickUpper)
          pool.liquidity += liquidityDelta
        this.addTick(tickLower, liquidityDelta, pool, block)
        this.addTick(tickUpper, -liquidityDelta, pool, block)
        break
      }
      case 'ProtocolFeeUpdated': {
        pool.protocolFee = event.args.protocolFee
        pool.swapFee = uniswapV4SwapFee(pool.lpFee, pool.protocolFee)
        break
      }
    }
    return false
  }

  /**
   * Adds the given liquidity delta to a tick of the given pool, in the word
   * the pool holds it in, nothing when the pool does not hold that word yet.
   * A word read in flight for the pool that is pinned before the log's block
   * takes the delta as well: the word it brings back replaces the live one,
   * so the delta is added back into it once it lands, see afterProcessLog
   */
  addTick(
    tick: number,
    amount: bigint,
    pool: UniswapV4PoolState,
    block: bigint,
  ) {
    const ticks = pool.ticks.get(bitmapIndex(tick, pool.tickSpacing))
    if (ticks !== undefined) addTickTo(ticks, tick, amount)
    this.tickReads.forEach((read) => {
      if (!read.pools.has(pool.id) || block <= read.block) return
      let deltas = read.deltas.get(pool.id)
      if (!deltas) {
        deltas = new Map()
        read.deltas.set(pool.id, deltas)
      }
      deltas.set(tick, (deltas.get(tick) ?? 0n) + amount)
    })
  }

  /** Queues the words around the pool's active tick that are not read yet, they are read at afterProcessLog */
  queueNewTicks(pool: UniswapV4PoolState) {
    this.queueWords(
      pool,
      this.windowWords(pool.activeTick, pool.tickSpacing).filter(
        (word) => !pool.ticks.has(word),
      ),
    )
  }

  /**
   * Queues the given words of the pool, once. A pool object a fetch replaced
   * is not queued, the object that replaced it read its own words
   */
  queueWords(pool: UniswapV4PoolState, words: number[]) {
    if (words.length === 0 || this.pools.get(pool.id) !== pool) return
    const queued = this.newTicksQueue.find(([p]) => p === pool)
    if (!queued) {
      this.newTicksQueue.push([pool, [...words]])
      return
    }
    words.forEach((word) => {
      if (!queued[1].includes(word)) queued[1].push(word)
    })
  }

  /**
   * Reads the queued tick table words at untilBlock. A pool ahead of the
   * round, a log of a later block moved it before the round began, waits
   * for a round at or past its block: a word read at this block would miss
   * that log. The logs that arrive while the words are read keep applying,
   * a mint or a burn into a word the read brings back is added into that
   * word once it lands, see addTick. A pool whose read failed waits for the
   * next round
   */
  override async afterProcessLog(untilBlock: bigint, _pools?: Set<string>) {
    const queued = this.newTicksQueue
      .splice(0)
      .filter(([, words]) => words.length > 0)
    queued
      .filter(([pool]) => pool.blockNumber > untilBlock)
      .forEach(([pool, words]) => this.queueWords(pool, words))
    const due = queued.filter(([pool]) => pool.blockNumber <= untilBlock)
    if (due.length === 0) return
    const read: TickRead = {
      block: untilBlock,
      pools: new Set(due.map(([pool]) => pool.id)),
      deltas: new Map(),
    }
    this.tickReads.add(read)
    let words: Awaited<ReturnType<typeof this.readTickWords>>
    try {
      words = await this.readTickWords(
        due.map(([pool, poolWords]) => ({
          id: pool.id,
          tickSpacing: pool.tickSpacing,
          words: poolWords,
        })),
        untilBlock,
      )
    } finally {
      this.tickReads.delete(read)
    }
    due.forEach(([pool, poolWords], i) => {
      const fetched = words?.[i]
      if (fetched === undefined) {
        this.queueWords(pool, poolWords)
        return
      }
      // a pool a fetch read again meanwhile has its own words
      if (this.pools.get(pool.id) !== pool) return
      const deltas = read.deltas.get(pool.id)
      fetched.forEach((ticks, word) => {
        if (deltas)
          mergeTickDeltas(
            ticks,
            deltas,
            (tick) => bitmapIndex(tick, pool.tickSpacing),
            word,
          )
        pool.ticks.set(word, ticks)
      })
    })
  }

  /**
   * Caches non existent pools
   */
  handleNullPool(id: string) {
    const v = this.nullPools.get(id)
    if (v) {
      this.nullPools.set(id, v + 1)
    } else {
      this.nullPools.set(id, 1)
    }
  }

  /**
   * Filters out already cached pools from the given list
   */
  filterCachedPools(pools: UniswapV4StaticPool[]) {
    return pools.filter((pool) => {
      if (this.pools.has(pool.id)) return false
      const nullPool = this.nullPools.get(pool.id)
      if (typeof nullPool === 'number' && nullPool > 1) return false
      return true
    })
  }

  /**
   * Resets the cache, the Initialize scans stay, the logs they read do not change
   */
  reset() {
    this.pools.clear()
    this.poolsByTrade.clear()
    this.nullPools.clear()
    this.newTicksQueue = []
  }
}
