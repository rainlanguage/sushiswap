import {
  Abi,
  Hex,
  Log,
  PublicClient,
  RpcLog,
  formatLog,
  hexToBigInt,
  toEventSelector,
} from 'viem'
import { ChainId } from '../../chain/constants.js'
import { Type } from '../../currency/index.js'
import {
  LiquidityProvider,
  LiquidityProviders,
} from '../liquidity-providers/LiquidityProvider.js'
import { RainDataFetcher, RainDataFetcherOptions } from './RainDataFetcher.js'
import { RainV2Pool, UniswapV2BaseProvider } from './UniswapV2Base.js'
import { RainV3Pool, UniswapV3BaseProvider } from './UniswapV3Base.js'
import { VelodromeSlipstreamBaseProvider } from './VelodromeSlipstreamBase.js'
import { logId } from './logId.js'
import { PoolMove, moveOf } from './moveDirection.js'

/** the delay before a dropped stream is opened again, in ms */
export const STREAM_RESUBSCRIBE_DELAY = 5_000

/**
 * the blocks below the newest head that the stream is trusted to have
 * served in full. the logs of a block and its head are separate frames,
 * so a head can land, and the socket die, before the logs of its block do
 */
export const STREAM_HEAD_MARGIN = 2n

/** without a head for this long the socket is taken as dead, in ms */
export const STREAM_STALL_TIMEOUT = 60_000

/** the most logs held back for a gap read, the oldest go beyond it */
export const STREAM_HELD_CAP = 100_000

/** how long stop() waits for the node to confirm the unsubscribes, in ms */
export const STREAM_UNSUBSCRIBE_TIMEOUT = 2_000

/** the blocks the read client can be behind the socket before the stream warns once */
export const STREAM_READ_LAG_WARN = 10n

/** the blocks one log read covers at most, the paging of the rpc specs */
const LOG_READ_SLICE = 1000n

/** a provider that holds pools */
export type TrackedProvider = UniswapV2BaseProvider | UniswapV3BaseProvider

/** a provider's cached pool, the object it applies its logs to */
export type LivePool = RainV2Pool | RainV3Pool

/** called with the pools whose state changed, and the newest block applied */
export type PoolsChangeCallback = (addresses: string[], block: bigint) => void

/**
 * called with the lowercase pool address, the log that moved its price and
 * the move's direction: true when the pool received token0 and paid token1,
 * false the other way round, undefined when the log tells none, see moveOf
 */
export type PoolChangeCallback = (
  address: string,
  log: Log,
  zeroForOne?: boolean,
) => void

export interface StreamOptions {
  /**
   * subscribe to pendingLogs and newFlashblocks (flashblocks) instead of
   * logs and newHeads, the sealed head is then the flashblock's block less
   * one, default false
   */
  flashblocks?: boolean
  /** called after each batch of applied logs with the pools it touched */
  onPoolsChange?: PoolsChangeCallback
  /**
   * called once per Swap or Sync log of a cached pool as the stream applies
   * it, with the move's direction when the log tells it, see moveOf. A log
   * the stream serves live only: a held log
   * replayed after a gap read, and a log the read brought, are history and
   * are not handed on. Inside the socket's message handler: it must return
   * at once and start its work asynchronously, a slow one delays the next
   * frames
   */
  onPoolChange?: PoolChangeCallback
  /** called once a pool creation was applied, the pair's pools can be fetched again */
  onPoolCreated?: () => void
  /** the delay before a dropped stream is opened again, default STREAM_RESUBSCRIBE_DELAY */
  resubscribeDelay?: number
  /** without a head for this long the stream counts as dropped, 0 turns it off, default STREAM_STALL_TIMEOUT */
  stallTimeout?: number
  /**
   * the sealed heads between two runs of the providers' afterProcessLog (the
   * tick words the Swaps queued, a slipstream provider's volatile fees), 1 is
   * every head, 2 every second head, default 1
   */
  followUpInterval?: number
  /**
   * run the follow up for the providers a log touched since their last run
   * only, and their fee re-reads for the touched pools only, a module wide
   * change widens that to every pool of the provider; false runs every
   * provider over every pool at each run, default true
   */
  followUpTouchedOnly?: boolean
}

type Subscription = { unsubscribe: () => Promise<unknown> }

/** the raw eth_subscribe of the viem ws transport */
type RawSubscribe = (args: {
  params: unknown[]
  onData: (data: { subscription?: string; result?: any }) => void
  onError?: (error: unknown) => void
}) => Promise<Subscription>

/** a hole in the stream, closed by a log read */
interface Gap {
  /** the pools to read, every pool when undefined */
  pools: Set<string> | undefined
  /**
   * the head to wait for before the read: the hole ends where the stream
   * begins, which is sure only once the head moved past the open by the
   * margin. undefined while the subscription that covers the pools is
   * not up yet
   */
  readyAt: bigint | undefined
  /** a read of this gap is in flight, see closeReadyGaps */
  reading?: boolean
}

export { logId }

/**
 * A RainDataFetcher that keeps its pools current from a log stream
 * instead of the polled updatePools() rounds. Init it like the parent,
 * fetch the pools, then start(): a newHeads and a logs subscription open
 * on the websocket client (with flashblocks a newFlashblocks and a
 * pendingLogs one, the sealed head is then the flashblock's block less
 * one), on the factories, the fee modules and every cached pool, with
 * every event the providers know. Each stream log goes through the
 * providers' processLog() in full mode, and the providers' afterProcessLog()
 * runs at the sealed head once per followUpInterval heads, for the
 * providers a log touched since their last run and their touched pools (or
 * every provider over every pool with followUpTouchedOnly off), as the
 * parent's round ran it once per update. The logs that arrive while those reads run keep
 * applying, a provider adds the changes of the ones that fall into what it
 * fetched back on top of the read, see UniswapV3BaseProvider.afterProcessLog.
 *
 * Gaps are closed by log reads, as the parent's round does: at start, from
 * each pool's own block to the head; after a drop, from the proven block
 * (the last head less the margin) to the head; after a fetch, for the
 * fetched pools from the fetch block. A read waits until the head moved
 * past the open by the margin, so the hole ends where the stream begins.
 * While a gap is open the stream logs of its pools are held back and
 * replayed after the read, since a log applied ahead of an older one
 * makes the pool reject the older one. Every log is applied once: the
 * ids of the applied logs of the recent blocks are kept, and a log at or
 * below the block a pool's state is complete through is skipped.
 *
 * The stream covers the admitted pool objects. A pool object a fetch
 * wrote into a provider's map is admitted by that fetch's end (or by a
 * fetch that ends before it), until then its logs are held and it takes
 * no part. On each head the idle admitted pools move up to the proven
 * block, the stream served no log for them, so a later gap read stays
 * short. In stream mode updatePools() only runs the gap reads that are
 * due, the stream does the rest, and a created pool is reported by
 * onPoolCreated
 */
export class RainDataFetcherStream extends RainDataFetcher {
  wsClient: PublicClient | undefined
  /** subscribe to pendingLogs and newFlashblocks (flashblocks) instead of logs and newHeads */
  flashblocks = false
  onPoolsChange: PoolsChangeCallback | undefined
  onPoolChange: PoolChangeCallback | undefined
  onPoolCreated: (() => void) | undefined
  resubscribeDelay = STREAM_RESUBSCRIBE_DELAY
  stallTimeout = STREAM_STALL_TIMEOUT
  followUpInterval = 1
  /** the follow up runs for the touched providers and pools only, see StreamOptions */
  followUpTouchedOnly = true
  /** the head the last follow up ran at, see followUp */
  followUpHead = -1n
  unsubscribeTimeout = STREAM_UNSUBSCRIBE_TIMEOUT
  /** the logs subscription, undefined while none is open */
  subscription: Subscription | undefined
  /** the heads subscription, undefined while none is open */
  headsSubscription: Subscription | undefined
  /** the pool addresses the logs subscription covers */
  subscribed: Set<string> = new Set()
  /** the fee module addresses the logs subscription covers */
  subscribedModules: string[] = []
  /** the newest sealed head served, -1n before the first */
  head = -1n
  /** the head the stream was opened at, a gap read waits for the margin past it */
  openedAt = -1n
  /** the newest block a log carried */
  lastLogBlock: bigint | undefined
  /** the stream is open, every log from now on is served */
  open = false
  /**
   * moves on every start, stop and drop. What began in an earlier epoch
   * (a subscription going up, a gap read) leaves the stream's state alone
   * when it ends
   */
  epoch = 0
  drops = 0
  lastError: unknown
  /** the lag warning was given, a read that runs clears it, see warnLag */
  lagWarned = false
  /**
   * the pool objects the stream covers, by lowercase address. A pool in a
   * provider's map that is not the admitted one was written by a fetch
   * that still runs, its logs are held until a fetch's end admits it
   */
  admitted: Map<string, LivePool> = new Map()
  /** the block through which each admitted pool's state is complete, by lowercase address */
  complete: Map<string, bigint> = new Map()
  /** the ids of the applied logs of the recent blocks, by address then block */
  applied: Map<string, Map<bigint, Set<string>>> = new Map()
  /**
   * the position of the newest module wide log applied per fee module and
   * event kind, by "address:topic0". Such a log sets a module setting
   * outright, so an older one that a read brings back must not undo a
   * newer one
   */
  moduleApplied: Map<string, { block: bigint; index: number }> = new Map()
  /** the gaps waiting for their read */
  gaps: Gap[] = []
  /** a gap read is running */
  closing = false
  /** the pools whose stream logs are held for a gap read */
  holding: Set<string> = new Set()
  /** every log is held, a gap over every pool is open */
  holdingAll = false
  /** the held logs, in arrival order */
  held: RpcLog[] = []
  /** the providers a log touched since their last follow up read, see followUp */
  private touchedProviders = new Set<TrackedProvider>()
  /**
   * the pools a log touched per touched provider, lowercase, what its fee
   * re-reads are kept to, null for every pool after a module wide change,
   * see mark
   */
  private touchedPools = new Map<TrackedProvider, Set<string> | null>()
  private touched: Set<string> = new Set()
  private created = false
  /** topic0 of the fee module events that name one pool, see feeKinds */
  private perPoolFeeKinds: Set<Hex> | undefined
  /** a changed fee module is being covered, see coverModules */
  private covering = false
  private tracked: TrackedProvider[] | undefined
  private logsGeneration = 0
  private flushTimer: ReturnType<typeof setImmediate> | undefined
  private resubscribeTimer: ReturnType<typeof setTimeout> | undefined
  private stallTimer: ReturnType<typeof setTimeout> | undefined
  private subscribing: Promise<void> | undefined
  private queued: Promise<void> | undefined
  private ready: (() => void) | undefined

  static override async init(
    chainId: ChainId,
    publicClient?: PublicClient,
    liquidityProviders?: LiquidityProviders[],
    initBlockNumber?: bigint,
  ): Promise<RainDataFetcherStream> {
    return (await super.init(
      chainId,
      publicClient,
      liquidityProviders,
      initBlockNumber,
    )) as RainDataFetcherStream
  }

  /** the providers that hold pools */
  get trackedProviders(): TrackedProvider[] {
    if (!this.tracked) {
      this.tracked = this.providers.filter(
        (p): p is TrackedProvider =>
          p instanceof UniswapV2BaseProvider ||
          p instanceof UniswapV3BaseProvider,
      )
    }
    return this.tracked
  }

  /** topic0 of every event the providers know */
  get topics(): Hex[] {
    return this.eventsAbi.map((item) => toEventSelector(item as any))
  }

  /** the slipstream fee module addresses, their logs change the pool fees */
  get feeModules(): string[] {
    const modules: string[] = []
    this.providers.forEach((provider) => {
      this.modulesOf(provider).forEach((module) => {
        if (!modules.includes(module)) modules.push(module)
      })
    })
    return modules
  }

  /** the lowercase fee module addresses of the given provider, none for one without */
  private modulesOf(provider: LiquidityProvider): string[] {
    if (!(provider instanceof VelodromeSlipstreamBaseProvider)) return []
    const module = (
      provider.swapFeeModule as Record<number, string | undefined>
    )[this.chainId]?.toLowerCase()
    return module ? [module] : []
  }

  /**
   * Opens the stream and closes the gap from each pool's block to the
   * head. Resolves once that first read is done, the pools are then at the
   * head and the stream keeps them there. A failed read is tried again on
   * the next head, so the caller may want a timeout of its own, and a
   * stop() before the first read makes it throw
   * @param wsClient - The websocket client to subscribe with
   * @param options - (optional) The flashblocks flag, the callbacks and the delays
   */
  async start(wsClient: PublicClient, options: StreamOptions = {}) {
    if (this.wsClient) throw new Error('the stream is started already')
    const epoch = ++this.epoch
    this.wsClient = wsClient
    this.flashblocks = options.flashblocks ?? false
    this.onPoolsChange = options.onPoolsChange
    this.onPoolChange = options.onPoolChange
    this.onPoolCreated = options.onPoolCreated
    this.resubscribeDelay = options.resubscribeDelay ?? STREAM_RESUBSCRIBE_DELAY
    this.stallTimeout = options.stallTimeout ?? STREAM_STALL_TIMEOUT
    const interval = options.followUpInterval ?? 1
    if (interval < 1) throw new Error('followUpInterval must be 1 or more')
    this.followUpInterval = interval
    this.followUpTouchedOnly = options.followUpTouchedOnly ?? true
    // every cached pool is admitted, complete through the block it was
    // read or updated at, with nothing applied on top of it yet
    this.admitted.clear()
    this.complete.clear()
    this.applied.clear()
    this.moduleApplied.clear()
    this.touched.clear()
    this.forEachPool((pool, address) => {
      this.admitted.set(address, pool)
      this.complete.set(address, pool.blockNumber)
    })
    const ready = new Promise<void>((resolve) => {
      this.ready = resolve
    })
    const opening = this.openStream(epoch).then(
      () => ready,
      async (e) => {
        // a failure of a stale open, a drop's reopen or a later start took
        // over, is nothing, the ready tells the rest
        if (this.epoch !== epoch) return ready
        // a failed open of this epoch: nothing else runs, so everything it
        // put up goes and the next start begins clean
        this.ready = undefined
        await this.stop()
        throw e
      },
    )
    // the first read, or a stop, whichever comes first: a hung open must not
    // hold a stop
    await Promise.race([ready, opening])
    if (!this.wsClient) {
      throw new Error('the stream was stopped before its first read')
    }
  }

  /**
   * Drops the stream, the pools stay as they are and updatePools() is the
   * parent's again. The wait for the node to confirm the unsubscribes is
   * bounded, a dead socket never answers
   */
  async stop() {
    this.epoch++
    this.wsClient = undefined
    this.open = false
    // the next start measures its open against the chain, not against the
    // last head this stream saw
    this.head = -1n
    this.openedAt = -1n
    this.followUpHead = -1n
    this.clearStall()
    if (this.resubscribeTimer !== undefined) clearTimeout(this.resubscribeTimer)
    this.resubscribeTimer = undefined
    if (this.flushTimer !== undefined) clearImmediate(this.flushTimer)
    this.flushTimer = undefined
    this.gaps = []
    this.lagWarned = false
    this.holdingAll = false
    this.holding.clear()
    this.held = []
    this.touchedProviders.clear()
    this.touchedPools.clear()
    this.subscribing = undefined
    this.queued = undefined
    this.covering = false
    this.ready?.()
    this.ready = undefined
    const logs = this.subscription
    const heads = this.headsSubscription
    this.subscription = undefined
    this.headsSubscription = undefined
    await this.bounded(
      Promise.allSettled([logs?.unsubscribe(), heads?.unsubscribe()]),
    )
  }

  /**
   * In stream mode the stream keeps the pools at the head, so this only
   * runs the gap reads that are due and reports a created pool among them.
   * Before start() and after stop() it is the parent's round, with its
   * shouldWait
   */
  override async updatePools(
    untilBlock?: bigint,
    shouldWait = true,
  ): Promise<boolean> {
    if (!this.wsClient) return super.updatePools(untilBlock, shouldWait)
    return this.closeReadyGaps()
  }

  /**
   * The parent's fetch, then in stream mode the pool objects in the maps
   * that are not admitted yet, the ones this fetch read, or a fetch that
   * runs alongside wrote, are admitted: complete through the block they
   * were read at, held, and covered by the subscription, which is replaced
   * when they are new to it. Once it covers them a gap read brings them
   * from that block to the head and lifts the hold. The fetch does not
   * wait for the socket, it resolves with the parent's. A fetch that began
   * before the stream started admits its pools the same way
   */
  override async fetchPoolsForToken(
    currency0: Type,
    currency1: Type,
    excludePools?: Set<string>,
    options?: RainDataFetcherOptions,
  ): Promise<void> {
    // the parent fills in the block when none is given, the pools carry it
    await super.fetchPoolsForToken(currency0, currency1, excludePools, options)
    if (!this.wsClient) return
    const fresh = new Map<string, LivePool>()
    this.forEachPool((pool, address) => {
      if (this.admitted.get(address) !== pool) fresh.set(address, pool)
    })
    if (!fresh.size) return
    fresh.forEach((pool, address) => {
      this.admitted.set(address, pool)
      // the pool carries the block it was read at, and no stream log
      // touched it: an object that is not admitted has its logs held
      this.complete.set(address, pool.blockNumber)
      // the logs applied to the object this one replaces are read again
      this.applied.delete(address)
    })
    // while the stream is down or going up the open covers them: its logs
    // subscription takes every pool, and its read runs from each pool's block
    if (!this.open) return
    const pools = new Set(fresh.keys())
    const gap = this.queueGap(pools, undefined)
    const grew = [...pools].some((address) => !this.subscribed.has(address))
    const epoch = this.epoch
    // the read is due once the subscription covers them and the margin
    // passed, a read before that would end below where the stream begins
    // for them. a drop or a stop meanwhile takes the gap with it
    const covered = grew ? this.resubscribe() : Promise.resolve()
    covered.then(
      () => {
        if (this.epoch !== epoch) return
        const since = this.head > this.openedAt ? this.head : this.openedAt
        gap.readyAt = since + STREAM_HEAD_MARGIN
        void this.closeReadyGaps()
      },
      (e) => {
        // the stream does not cover the new pools, the reopen does
        if (this.epoch === epoch) this.onDrop(e)
      },
    )
  }

  /** The parent's reset, and the stream's bookkeeping of the pools goes with them */
  override reset() {
    super.reset()
    this.admitted.clear()
    this.complete.clear()
    this.applied.clear()
    this.touched.clear()
    this.holding.clear()
    this.held = []
    this.gaps = this.gaps.filter((gap) => gap.pools === undefined)
  }

  /**
   * Applies one raw log of the stream, or holds it while its pool's gap is
   * open or its pool object is not admitted yet
   */
  onLog(raw: RpcLog, replay = false) {
    if (!this.wsClient) return
    // nothing may throw out of the socket's message handler, it would end
    // the process: a frame that is not a log is dropped
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.address !== 'string' ||
      !Array.isArray(raw.topics)
    ) {
      return
    }
    try {
      // a fee module log about one pool is held with that pool, a module
      // wide one is never held, the provider applies it to the pools behind it
      const pool = this.poolOfLog(raw.address, raw.topics)
      if (this.holdingAll || this.holding.has(pool) || this.unadmitted(pool)) {
        this.held.push(raw)
        if (this.held.length > STREAM_HELD_CAP) this.held.shift()
        return
      }
      // hex fields to bigint / number, processLog compares block numbers
      const log = formatLog(raw) as Log
      // the move a live Swap or Sync tells is read before the log applies, a
      // Sync's direction is its change against the reserves the pool holds now
      const move =
        !replay && this.onPoolChange ? this.moveOf(pool, log) : undefined
      const { applied, created } = this.apply(log)
      if (created) this.created = true
      if (applied && move) {
        this.notify(() => this.onPoolChange?.(pool, log, move.zeroForOne))
      }
      this.scheduleFlush()
    } catch (e: any) {
      console.warn(`pools stream log failed, message: ${e?.message}`)
    }
  }

  /**
   * The move a log tells about a cached pool, a Swap or a Sync of it with the
   * direction, see moveOf, undefined for any other log or a pool not held
   * @param address - the lowercase pool address
   * @param log - the log
   */
  private moveOf(address: string, log: Log): PoolMove | undefined {
    const provider = this.trackedProviders.find((p) => p.pools.has(address))
    if (!provider) return undefined
    const pool = provider.pools.get(address) as
      | { reserve0?: unknown; reserve1?: unknown }
      | undefined
    const previous =
      typeof pool?.reserve0 === 'bigint' && typeof pool?.reserve1 === 'bigint'
        ? ([pool.reserve0, pool.reserve1] as [bigint, bigint])
        : undefined
    return moveOf(provider.eventsAbi as Abi, log, previous)
  }

  /**
   * Takes a sealed head: the idle admitted pools move up to the proven
   * block, the ids below it go, and the gap reads that are due run. While
   * a gap over every pool is open nothing is proven, its read settles the
   * pools
   */
  onHead(number: bigint) {
    if (!this.wsClient || number <= this.head) return
    this.head = number
    this.armStall()
    if (!this.holdingAll) {
      const proven = number - STREAM_HEAD_MARGIN
      this.admitted.forEach((pool, address) => {
        // a held pool has logs the stream did not serve yet, and a replaced
        // one is the running fetch's to admit
        if (this.holding.has(address) || this.poolOf(address) !== pool) return
        if (pool.blockNumber < proven) pool.blockNumber = proven
        const complete = this.complete.get(address)
        if (complete === undefined || complete < proven)
          this.complete.set(address, proven)
      })
      this.applied.forEach((blocks, address) => {
        // a held pool keeps its ids: its read starts at its complete block,
        // which stands still, and brings the logs the stream applied above it
        if (this.holding.has(address)) return
        blocks.forEach((_, block) => {
          if (block < proven) blocks.delete(block)
        })
        if (!blocks.size) this.applied.delete(address)
      })
    }
    void this.closeReadyGaps()
    // the follow up reads of the providers a log touched, once per
    // followUpInterval heads, see followUp
    if (number - this.followUpHead >= BigInt(this.followUpInterval)) {
      this.followUpHead = number
      void this.followUp()
    }
  }

  /**
   * Applies one log through the providers, unless it was applied before or
   * the pool's state is complete through its block already
   * @returns whether the log applied, and whether it was a pool creation
   */
  private apply(log: Log): { applied: boolean; created: boolean } {
    const skipped = { applied: false, created: false }
    if (log.removed) return skipped
    const address = log.address.toLowerCase()
    // the pool the log is about keys its dedupe: a fee module log of one pool
    // is deduped with that pool, so a pool admitted later gets it from its read
    const pool = this.poolOfLog(address, log.topics)
    const block = log.blockNumber
    if (block !== null) {
      const complete = this.complete.get(pool)
      if (complete !== undefined && block <= complete) return skipped
      const id = logId(log)
      let blocks = this.applied.get(pool)
      if (!blocks) {
        blocks = new Map()
        this.applied.set(pool, blocks)
      }
      const ids = blocks.get(block)
      if (ids?.has(id)) return skipped
      if (ids) ids.add(id)
      else blocks.set(block, new Set([id]))
      if (this.lastLogBlock === undefined || block > this.lastLogBlock)
        this.lastLogBlock = block
    }
    if (
      pool === address &&
      log.topics[0] &&
      this.feeModules.includes(address)
    ) {
      // a module wide log: applied only when it is newer than the last one of
      // its kind, the provider sets the setting with no order check of its own
      const kind = `${address}:${log.topics[0]}`
      const newest = this.moduleApplied.get(kind)
      if (block !== null && log.logIndex !== null) {
        if (
          newest &&
          (block < newest.block ||
            (block === newest.block && log.logIndex <= newest.index))
        ) {
          return skipped
        }
        this.moduleApplied.set(kind, { block, index: log.logIndex })
      }
    }
    let created = false
    this.trackedProviders.forEach((provider) => {
      if (provider.processLog(log)) created = true
      if (provider.pools.has(pool)) {
        this.touched.add(pool)
        this.mark(provider, pool)
      } else if (
        (pool === address && this.modulesOf(provider).includes(address)) ||
        (provider instanceof VelodromeSlipstreamBaseProvider &&
          provider.shouldResetFees)
      ) {
        // a module wide log moved the provider's fee settings, or a fee
        // reset is pending, a module change: every pool of the provider is
        // touched
        this.mark(provider, 'all')
      }
    })
    // a factory log may have moved a fee module: the cover must hold the
    // pools before a held log is replayed or the next log applies
    if (
      this.open &&
      !this.covering &&
      this.factories.includes(address) &&
      !this.modulesCovered()
    ) {
      this.coverModules()
    }
    return { applied: true, created }
  }

  /**
   * Runs flush() once after the logs of this event loop pass are applied.
   * setImmediate runs right after the current I/O pass, so the logs of one
   * read go out in one report. The callback clears its own handle when the
   * flush is done, and stop() clears a pending one
   */
  private scheduleFlush() {
    if (this.flushTimer !== undefined) return
    const timer = setImmediate(() => {
      this.flushTimer = undefined
      try {
        this.flush()
      } finally {
        clearImmediate(timer)
      }
    })
    this.flushTimer = timer
  }

  /**
   * Reports the pools a batch of logs changed and a creation, and covers a
   * fee module address that changed (SwapFeeModuleChanged) and is not in
   * the subscription yet
   */
  private flush() {
    const touched = [...this.touched]
    this.touched.clear()
    const created = this.created
    this.created = false
    if (this.open && !this.covering && !this.modulesCovered()) {
      this.coverModules()
    }
    if (created) this.notify(() => this.onPoolCreated?.())
    if (touched.length) {
      this.notify(() =>
        this.onPoolsChange?.(touched, this.lastLogBlock ?? this.head),
      )
    }
  }

  /**
   * Runs the providers' afterProcessLog at the sealed head: the tick words
   * the Swaps queued, and a slipstream provider's volatile fees and fee
   * resets. Once per followUpInterval heads, see onHead, for the providers
   * a log touched since their last run only, so a provider no log touched
   * reads nothing until one does, its volatile fees included. The logs that
   * arrive while the reads run keep applying, a provider adds the changes of
   * the ones that fall into what it fetched back on top of the read, see
   * UniswapV3BaseProvider.afterProcessLog. The queued work of a held pool
   * waits: its logs since its read's end are held or still to be read, a
   * word or a balance fetched at the head now would take them twice once
   * they replay, so it is read at the first head after the release
   */
  private async followUp() {
    // every pool is held while the gap over them is read, that read runs the
    // follow up itself, the marks keep
    if (this.holdingAll) return
    // a pending block cannot be read, so the sealed head is the block
    const block =
      this.flashblocks || this.lastLogBlock === undefined
        ? this.head
        : this.lastLogBlock > this.head
          ? this.lastLogBlock
          : this.head
    if (block < 0n) return
    // the touched providers with the pools a log touched, or every provider
    // over every pool, see StreamOptions.followUpTouchedOnly
    const providers = this.followUpTouchedOnly
      ? [...this.touchedProviders]
      : this.trackedProviders
    const scopes = this.followUpTouchedOnly
      ? new Map(this.touchedPools)
      : new Map<TrackedProvider, Set<string> | null>()
    this.touchedProviders.clear()
    this.touchedPools.clear()
    if (!providers.length) return
    const parked = this.parkHeld(providers)
    await Promise.allSettled(
      providers.map((p) =>
        p.afterProcessLog(block, scopes.get(p) ?? undefined),
      ),
    )
    parked()
    this.remarkPending(providers)
  }

  /**
   * Marks a provider for the next follow up: with the pool a log touched,
   * with every pool ('all', a module wide change), or with no pool more
   * ('none', work left from its last run), see followUp
   * @param provider - The provider
   * @param scope - The pool's lowercase address, 'all' or 'none'
   */
  private mark(provider: TrackedProvider, scope: string) {
    this.touchedProviders.add(provider)
    const current = this.touchedPools.get(provider)
    if (current === null) return
    if (scope === 'all') this.touchedPools.set(provider, null)
    else if (scope === 'none') {
      if (!current) this.touchedPools.set(provider, new Set())
    } else if (current) current.add(scope)
    else this.touchedPools.set(provider, new Set([scope]))
  }

  /**
   * Takes the queued work of the held pools out of the given providers'
   * queues, the tick words of a univ3 provider and the balance reads of an
   * algebra integral one, and hands back the function that puts it back
   * @param providers - The providers about to run their follow up
   */
  private parkHeld(providers: TrackedProvider[]): () => void {
    if (!this.holding.size) return () => {}
    const held = (pool: RainV3Pool) => this.isHeld(pool)
    const restores: (() => void)[] = []
    providers.forEach((provider) => {
      if (!(provider instanceof UniswapV3BaseProvider)) return
      const words = provider.newTicksQueue.filter(([pool]) => held(pool))
      if (words.length) {
        provider.newTicksQueue = provider.newTicksQueue.filter(
          ([pool]) => !held(pool),
        )
        // a read may have queued the pool again meanwhile, the words join
        // that entry
        restores.push(() =>
          words.forEach(([pool, parked]) => {
            const entry = provider.newTicksQueue.find(
              ([queued]) => queued.address === pool.address,
            )
            if (!entry) provider.newTicksQueue.push([pool, parked])
            else parked.forEach((w) => entry[1].includes(w) || entry[1].push(w))
          }),
        )
      }
      // the algebra integral balance re-reads, kept by duck type, the class
      // lives behind an import cycle
      const withBalances = provider as {
        onSwapPluginFeeUpdatePools?: RainV3Pool[]
      }
      const balances = withBalances.onSwapPluginFeeUpdatePools
      if (Array.isArray(balances)) {
        const kept = balances.filter((pool) => held(pool))
        if (kept.length) {
          withBalances.onSwapPluginFeeUpdatePools = balances.filter(
            (pool) => !held(pool),
          )
          restores.push(() =>
            kept.forEach((pool) => {
              const list = withBalances.onSwapPluginFeeUpdatePools!
              if (!list.some((v) => v.address === pool.address)) list.push(pool)
            }),
          )
        }
      }
    })
    return () => restores.forEach((restore) => restore())
  }

  /** whether the pool's logs are held for a gap read, see holding */
  private isHeld(pool: RainV3Pool): boolean {
    return this.holding.has(pool.address.toLowerCase())
  }

  /**
   * Marks the providers among the given that still have work after their
   * follow up read, so the next head's run takes them again, a log need not
   * touch them: a univ3 provider whose tick words are still queued, its read
   * failed, and a slipstream provider whose fee reset waits for a round at
   * or past the change block
   */
  private remarkPending(providers: TrackedProvider[]) {
    providers.forEach((provider) => {
      const withBalances = provider as {
        onSwapPluginFeeUpdatePools?: RainV3Pool[]
      }
      if (
        provider instanceof VelodromeSlipstreamBaseProvider &&
        provider.shouldResetFees
      ) {
        // the module changed, every pool of the provider is touched
        this.mark(provider, 'all')
      } else if (
        (provider instanceof UniswapV3BaseProvider &&
          provider.newTicksQueue.some(([pool]) => !this.isHeld(pool))) ||
        withBalances.onSwapPluginFeeUpdatePools?.some(
          (pool) => !this.isHeld(pool),
        )
      ) {
        // the work of a held pool is not counted, its release marks its
        // provider, see closeGap
        this.mark(provider, 'none')
      }
    })
  }

  /** a throwing callback does not break the stream */
  private notify(fn: () => void) {
    try {
      fn()
    } catch (e: any) {
      console.warn(`pools stream callback failed, message: ${e?.message}`)
    }
  }

  /**
   * Queues a gap: its pools' stream logs are held from now on. A gap over
   * every pool takes the place of a pending one. The gaps of single pools
   * stay, one of them may end past the read of the whole
   */
  private queueGap(
    pools: Set<string> | undefined,
    readyAt: bigint | undefined,
  ): Gap {
    const gap: Gap = { pools, readyAt }
    if (pools === undefined) {
      this.holdingAll = true
      this.gaps = [gap, ...this.gaps.filter((g) => g.pools !== undefined)]
      return gap
    }
    pools.forEach((address) => this.holding.add(address))
    this.gaps.push(gap)
    return gap
  }

  /**
   * Runs the due gap reads, merged into one read. A gap is due once the
   * socket head and the read client's head both reached it. A gap the read
   * client did not reach yet waits for a later head, so it does not hold
   * back the gaps before it. A read that fails leaves its gaps for the next
   * head
   * @returns true if a pool creation was applied
   */
  private async closeReadyGaps(): Promise<boolean> {
    if (this.closing || !this.open || this.head < 0n) return false
    const due = (gap: Gap, block: bigint) =>
      gap.readyAt !== undefined && gap.readyAt <= block
    if (!this.gaps.some((gap) => due(gap, this.head))) return false
    this.closing = true
    const epoch = this.epoch
    const head = this.head
    let ready: Gap[] = []
    let created = false
    let failed = false
    try {
      // the cached block number of viem can be some blocks old
      const chainHead = await this.web3Client.getBlockNumber({ cacheTime: 0 })
      if (this.epoch !== epoch) return false
      const to = chainHead < this.head ? chainHead : this.head
      ready = this.gaps.filter((gap) => due(gap, to))
      if (!ready.length) {
        this.warnLag(chainHead)
        return false
      }
      this.lagWarned = false
      ready.forEach((gap) => {
        gap.reading = true
      })
      const all = ready.some((gap) => gap.pools === undefined)
      const single = new Set(
        ready.flatMap((gap) => (gap.pools ? [...gap.pools] : [])),
      )
      // the read must reach where the stream begins for every gap in it
      const need = ready.reduce(
        (max, gap) => (gap.readyAt! > max ? gap.readyAt! : max),
        0n,
      )
      created = await this.closeGap(all ? undefined : single, to, need, single)
      this.gaps = this.gaps.filter((gap) => !ready.includes(gap))
    } catch (e: any) {
      failed = true
      ready.forEach((gap) => {
        gap.reading = false
      })
      this.lastError = e
      console.warn(`pools gap read failed, message: ${e?.message ?? e}`)
    } finally {
      this.closing = false
    }
    // a head that came in during the read could not start one, a failed
    // read waits for the next head
    if (
      !failed &&
      this.head > head &&
      this.gaps.some((gap) => due(gap, this.head))
    ) {
      void this.closeReadyGaps()
    }
    return created
  }

  /**
   * Warns once when the due gaps wait for a read client that is far behind
   * the socket, the held logs of their pools grow meanwhile
   */
  private warnLag(chainHead: bigint) {
    if (this.lagWarned || this.head - chainHead < STREAM_READ_LAG_WARN) return
    this.lagWarned = true
    console.warn(
      `pools gap read waits for the read client, it is at block ${chainHead}, the stream is at block ${this.head}`,
    )
  }

  /**
   * Reads the logs from the block each pool is complete through to the
   * given block, for the given pools or every admitted pool, applies the
   * ones not applied yet in order, moves the pools to that block, then
   * replays the held logs. The block is at or below the read client's head,
   * a read past it would come back short and be taken as whole. A read
   * that ends below where the stream begins for the gaps, a failed slice,
   * leaves the pools where it got and throws, so the gaps stay open and the
   * holds stay on. One that ends past it closes them, the stream serves
   * the blocks after it. A read that ends in a later epoch (a drop or a
   * stop meanwhile) applies its logs, they are the chain's, and leaves the
   * rest alone
   * @param pools - The pools to read, every pool when undefined
   * @param end - The block to read up to, at or below the read client's head
   * @param need - The block the read must reach, where the stream begins for the gaps
   * @param lift - The single pools whose holds the read lifts
   * @returns true if a pool creation was applied
   */
  private async closeGap(
    pools: Set<string> | undefined,
    end: bigint,
    need: bigint,
    lift: Set<string>,
  ): Promise<boolean> {
    const epoch = this.epoch
    const scoped = new Map<string, LivePool>()
    let from = -1n
    this.admitted.forEach((pool, address) => {
      if (pools && !pools.has(address)) return
      // a replaced object is the running fetch's to read
      if (this.poolOf(address) !== pool) return
      const complete = this.complete.get(address) ?? pool.blockNumber
      if (complete >= end) return
      scoped.set(address, pool)
      if (from === -1n || complete < from) from = complete
    })
    let created = false
    let until = end
    if (scoped.size) {
      const addresses = [
        ...this.factories,
        ...this.feeModules,
        ...scoped.keys(),
      ] as `0x${string}`[]
      const slices: { from: bigint; to: bigint }[] = []
      for (let start = from + 1n; start <= end; ) {
        const stop =
          start + LOG_READ_SLICE - 1n < end ? start + LOG_READ_SLICE - 1n : end
        slices.push({ from: start, to: stop })
        start = stop + 1n
      }
      const results = await Promise.allSettled(
        slices.map((slice) =>
          this.web3Client.getLogs({
            events: this.eventsAbi,
            address: addresses,
            fromBlock: slice.from,
            toBlock: slice.to,
          }),
        ),
      )
      const logs: Log[] = []
      until = from
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!
        if (result.status === 'rejected') {
          if (i === 0) throw result.reason
          break
        }
        logs.push(...(result.value as Log[]))
        until = slices[i]!.to
      }
      logs.sort((a, b) => {
        const diff = a.blockNumber! - b.blockNumber!
        if (diff !== 0n) return diff < 0n ? -1 : 1
        const txDiff = a.transactionIndex! - b.transactionIndex!
        return txDiff !== 0 ? txDiff : a.logIndex! - b.logIndex!
      })
      logs.forEach((log) => {
        const address = log.address.toLowerCase()
        const pool = this.poolOfLog(address, log.topics)
        // a fee module log of a pool outside the read is that pool's own
        // read's, or the stream's, to apply
        if (pool !== address && !scoped.has(pool)) return
        // a pool a fetch replaced during the read is the fetch's to read
        const read = scoped.get(pool)
        if (read && this.poolOf(pool) !== read) return
        if (this.apply(log).created) created = true
      })
      if (this.epoch !== epoch) return created
      scoped.forEach((pool, address) => {
        // a pool a fetch replaced or admitted again during the read is the
        // fetch's, its bookkeeping and its hold stay as the fetch left them
        if (
          this.admitted.get(address) !== pool ||
          this.poolOf(address) !== pool
        ) {
          lift.delete(address)
          return
        }
        // a read that stopped short moves no pool that was ahead of its end
        const prior = this.complete.get(address) ?? pool.blockNumber
        if (prior < until) this.complete.set(address, until)
        if (pool.blockNumber < until) pool.blockNumber = until
      })
      if (pools === undefined) {
        // the gap over every pool: nothing streamed while it was read, so
        // the read's block is current for every provider and their follow up
        // reads run at it. The marks the read's logs set are spent here
        const providers = this.trackedProviders
        this.touchedProviders.clear()
        this.touchedPools.clear()
        await Promise.allSettled(providers.map((p) => p.afterProcessLog(until)))
        this.remarkPending(providers)
      }
      // a gap over some pools runs no follow up here: the others kept
      // streaming past the read's block, so a read pinned at it would bring
      // their queued words without the logs since. The gap's pools are read
      // by the next head's follow up, see below
      if (created) this.created = true
      this.scheduleFlush()
    }
    if (this.epoch !== epoch) return created
    if (until < need) {
      throw new Error(`the log read stopped at block ${until}`)
    }
    if (pools !== undefined) {
      // the gap's pools are current to the stream from here: the next head's
      // follow up reads their providers at a block at or past every log
      scoped.forEach((_, address) => {
        const provider = this.trackedProviders.find((p) => p.pools.has(address))
        if (provider) this.mark(provider, address)
      })
    }
    this.release(pools, lift)
    return created
  }

  /**
   * Lifts the holds the read covered, the hold of every pool when it read
   * every pool, and replays the held logs in order. A log of a pool that
   * is still held goes back on hold
   */
  private release(pools: Set<string> | undefined, lift: Set<string>) {
    lift.forEach((address) => {
      // a pool another pending gap names stays held for that gap's read
      const named = this.gaps.some(
        (gap) => !gap.reading && gap.pools?.has(address),
      )
      if (!named) this.holding.delete(address)
    })
    if (pools === undefined) this.holdingAll = false
    const held = this.held
    this.held = []
    // a replay, the logs are history, the pool change callback is not made
    held.forEach((raw) => this.onLog(raw, true))
    if (pools === undefined) {
      this.ready?.()
      this.ready = undefined
    }
  }

  /** the raw subscribe of the ws transport */
  private rawSubscribe(): RawSubscribe {
    const transport = this.wsClient?.transport as
      | { subscribe?: RawSubscribe }
      | undefined
    if (typeof transport?.subscribe !== 'function') {
      throw new Error('a websocket client is required for the stream')
    }
    return (args) => transport.subscribe!(args)
  }

  /**
   * Opens the heads and the logs subscriptions, then queues the gap over
   * every pool up to where the stream begins for sure. An open that
   * outlives its epoch, a drop or a stop came meanwhile, drops what it
   * put up and returns
   */
  private async openStream(epoch: number) {
    // throws at once without a websocket client
    this.rawSubscribe()
    // every log is held until the gap to where the stream begins is read,
    // and a head served before that must not move the pools up
    this.holdingAll = true
    this.holding.clear()
    // a node that never answers the subscribe is a dead socket as well
    this.armStall()
    // a node that never answers a subscribe keeps nothing else quiet here,
    // the wait is bounded by the stall timeout
    await this.within(
      this.subscribeHeads(),
      this.stallTimeout,
      'the subscribe got no answer',
    )
    if (this.epoch !== epoch) return
    // a node that answers the heads but never the logs subscribe keeps the
    // stall timer quiet, so this wait is bounded by the same timeout
    await this.within(
      this.subscribeLogs(),
      this.stallTimeout,
      'the subscribe got no answer',
    )
    if (this.epoch !== epoch) return
    // the open is measured against the newer of the two heads: the last
    // one the socket served, which is behind after a long drop, and the
    // read client's. The cached block number of viem can be some blocks
    // old, and a value below where the logs subscription began lets the
    // read stop short of it
    const chainHead = await this.web3Client.getBlockNumber({ cacheTime: 0 })
    if (this.epoch !== epoch) return
    this.openedAt = this.head > chainHead ? this.head : chainHead
    this.open = true
    // the pools fetched while the subscriptions went up are not in them yet
    while (this.uncovered()) {
      await this.resubscribe()
      if (this.epoch !== epoch) return
      if (this.head > this.openedAt) this.openedAt = this.head
    }
    this.queueGap(undefined, this.openedAt + STREAM_HEAD_MARGIN)
    this.armStall()
    void this.closeReadyGaps()
  }

  /** a pool or a fee module the logs subscription does not cover exists */
  private uncovered(): boolean {
    let found = !this.modulesCovered()
    this.forEachPool((_, address) => {
      if (!this.subscribed.has(address)) found = true
    })
    return found
  }

  /** every fee module address is in the logs subscription */
  private modulesCovered(): boolean {
    return this.feeModules.every((module) =>
      this.subscribedModules.includes(module),
    )
  }

  /**
   * the lowercase address of the pool a log is about: its own, or for a
   * fee module log of one pool (CustomFeeSet, ScalingFactorSet, ...) the
   * pool it names in its first topic, cached or not. A module wide fee
   * module log (DefaultFeeCapSet, ...) is about the module itself, it is
   * never held and every read applies it
   */
  private poolOfLog(address: string, topics: readonly Hex[]): string {
    const lower = address.toLowerCase()
    if (
      topics.length > 1 &&
      this.feeModules.includes(lower) &&
      this.feeKinds().has(topics[0]!)
    ) {
      return `0x${topics[1]!.slice(26)}`.toLowerCase()
    }
    return lower
  }

  /**
   * topic0 of the events that name one pool in their first input, an
   * indexed address, the fee module events of one pool among them
   */
  private feeKinds(): Set<Hex> {
    if (!this.perPoolFeeKinds) {
      this.perPoolFeeKinds = new Set(
        this.eventsAbi
          .filter((item: any) => {
            const first = item.inputs?.[0]
            return first?.type === 'address' && first.indexed === true
          })
          .map((item) => toEventSelector(item as any)),
      )
    }
    return this.perPoolFeeKinds
  }

  /**
   * Covers a fee module address that changed: the slipstream pools are
   * held, the subscription is replaced with the new address in it, and a
   * gap read brings the new module's logs from the pools' complete blocks
   * to past the new subscription's start, as a fetch does for its pools.
   * The logs of the new module between the change and the new subscription
   * are in no subscription, and the provider's reset read of its settings
   * runs at a head, so a setting set after that head would be missed
   */
  private coverModules() {
    this.covering = true
    const epoch = this.epoch
    const pools = new Set<string>()
    this.providers.forEach((provider) => {
      if (!(provider instanceof VelodromeSlipstreamBaseProvider)) return
      const module = (
        provider.swapFeeModule as Record<number, string | undefined>
      )[this.chainId]?.toLowerCase()
      if (!module || this.subscribedModules.includes(module)) return
      provider.pools.forEach((_, address) => pools.add(address.toLowerCase()))
    })
    const gap = this.queueGap(pools, undefined)
    this.resubscribe().then(
      () => {
        this.covering = false
        if (this.epoch !== epoch) return
        const since = this.head > this.openedAt ? this.head : this.openedAt
        gap.readyAt = since + STREAM_HEAD_MARGIN
        void this.closeReadyGaps()
      },
      (e) => {
        this.covering = false
        if (this.epoch === epoch) this.onDrop(e)
      },
    )
  }

  /** the promise, or a rejection once the timeout passed, 0 means no timeout */
  private within<T>(
    promise: Promise<T>,
    ms: number,
    message: string,
  ): Promise<T> {
    if (!ms) return promise
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms)
      timer.unref?.()
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
  }

  /**
   * Opens the heads subscription, the stream's proof that the socket is
   * alive, the previous one is dropped once the new one is up. One that
   * comes up in a later epoch is dropped itself
   */
  private async subscribeHeads() {
    const subscribe = this.rawSubscribe()
    const epoch = this.epoch
    // an error of a replaced subscription is not a drop, and an error while
    // the subscribe is pending rejects the subscribe itself
    const slot: { heads?: Subscription } = {}
    slot.heads = await subscribe({
      // with flashblocks the heads are the flashblocks, each names the block
      // it builds, so the block before it is the sealed head
      params: [this.flashblocks ? 'newFlashblocks' : 'newHeads'],
      onData: (data) => {
        if (slot.heads && this.headsSubscription !== slot.heads) return
        // a frame that is not a head must not throw out of the handler
        try {
          const number = data?.result?.number
          if (!number) return
          const head = hexToBigInt(number)
          if (!this.flashblocks) this.onHead(head)
          else if (head > 0n) this.onHead(head - 1n)
        } catch {}
      },
      onError: (e) => {
        if (!slot.heads || this.headsSubscription !== slot.heads) return
        this.onDrop(e)
      },
    })
    if (this.epoch !== epoch) {
      void slot.heads.unsubscribe().catch(() => {})
      return
    }
    const previous = this.headsSubscription
    this.headsSubscription = slot.heads
    void previous?.unsubscribe().catch(() => {})
  }

  /**
   * Opens a logs subscription on the factories, the fee modules and every
   * pool, the previous one is dropped once the new one is up. One that
   * comes up after a newer one, or in a later epoch, is dropped itself
   */
  private async subscribeLogs() {
    const subscribe = this.rawSubscribe()
    const epoch = this.epoch
    const generation = ++this.logsGeneration
    const pools = new Set<string>()
    this.forEachPool((_, address) => pools.add(address))
    const modules = this.feeModules
    const address = [...this.factories, ...modules, ...pools]
    const slot: { logs?: Subscription } = {}
    slot.logs = await subscribe({
      params: [
        this.flashblocks ? 'pendingLogs' : 'logs',
        { address, topics: [this.topics] },
      ],
      onData: (data) => {
        if (slot.logs && this.subscription !== slot.logs) return
        if (data?.result) this.onLog(data.result)
      },
      onError: (e) => {
        if (!slot.logs || this.subscription !== slot.logs) return
        this.onDrop(e)
      },
    })
    if (this.epoch !== epoch || generation !== this.logsGeneration) {
      void slot.logs.unsubscribe().catch(() => {})
      return
    }
    const previous = this.subscription
    this.subscription = slot.logs
    this.subscribed = pools
    this.subscribedModules = modules
    // never awaited: a dead socket never answers an unsubscribe, and a
    // subscription that lives on only serves logs the ids reject
    void previous?.unsubscribe().catch(() => {})
  }

  /**
   * Replaces the logs subscription with one over the pools of now. Calls
   * that come in while one is in flight share the next one. A drop or a
   * stop lets go of the one in flight, it may never settle
   */
  private resubscribe(): Promise<void> {
    if (this.queued) return this.queued
    const epoch = this.epoch
    const inFlight = this.subscribing
    const slot: { queued?: Promise<void> } = {}
    slot.queued = (async () => {
      await inFlight?.catch(() => {})
      if (this.queued === slot.queued) this.queued = undefined
      if (this.epoch !== epoch) return
      const current = this.subscribeLogs()
      this.subscribing = current
      try {
        // a subscribe the node never answers must not hold pools for good,
        // the heads keep the stall timer quiet meanwhile
        await this.within(
          current,
          this.stallTimeout,
          'the subscribe got no answer',
        )
      } finally {
        if (this.subscribing === current) this.subscribing = undefined
      }
    })()
    this.queued = slot.queued
    return slot.queued
  }

  /**
   * Drops both subscriptions, holds every log, and opens the stream again
   * after the delay. The reopen queues the gap over every pool
   */
  private onDrop(error: unknown) {
    if (!this.wsClient) return
    this.epoch++
    this.lastError = error
    this.drops++
    this.open = false
    this.clearStall()
    const logs = this.subscription
    const heads = this.headsSubscription
    this.subscription = undefined
    this.headsSubscription = undefined
    void logs?.unsubscribe().catch(() => {})
    void heads?.unsubscribe().catch(() => {})
    // what was going up may never settle on a dead socket
    this.subscribing = undefined
    this.queued = undefined
    this.covering = false
    // every pool may miss logs from here, the reopen's gap covers them all
    this.holdingAll = true
    this.holding.clear()
    this.gaps = []
    console.warn(
      `pools stream dropped, message: ${(error as any)?.message ?? error}`,
    )
    if (this.resubscribeTimer !== undefined) return
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = undefined
      const epoch = this.epoch
      this.openStream(epoch).catch((e) => {
        // a failure of a stale open, another reopen or a start took over
        if (this.epoch === epoch) this.onDrop(e)
      })
    }, this.resubscribeDelay)
    // the wait must not keep the process alive on its own
    this.resubscribeTimer.unref?.()
  }

  /** Starts the stall watch over, a silent socket death serves no heads */
  private armStall() {
    this.clearStall()
    if (!this.stallTimeout) return
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined
      this.onDrop(new Error(`no head for ${this.stallTimeout} ms`))
    }, this.stallTimeout)
    this.stallTimer.unref?.()
  }

  private clearStall() {
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer)
    this.stallTimer = undefined
  }

  /** resolves with the promise, or once the unsubscribe timeout passed */
  private bounded(promise: Promise<unknown>): Promise<unknown> {
    return Promise.race([
      promise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.unsubscribeTimeout)
        timer.unref?.()
      }),
    ])
  }

  /** the address holds a pool object a running fetch wrote and no fetch admitted yet */
  private unadmitted(address: string): boolean {
    const pool = this.poolOf(address)
    return pool !== undefined && this.admitted.get(address) !== pool
  }

  /** the pool object a provider holds at the address */
  private poolOf(address: string): LivePool | undefined {
    for (const provider of this.trackedProviders) {
      const pool = provider.pools.get(address)
      if (pool) return pool
    }
    return undefined
  }

  private forEachPool(fn: (pool: LivePool, address: string) => void) {
    this.trackedProviders.forEach((provider) =>
      provider.pools.forEach((pool, address) =>
        fn(pool, address.toLowerCase()),
      ),
    )
  }
}
