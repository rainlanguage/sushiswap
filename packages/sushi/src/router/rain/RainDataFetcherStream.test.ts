import '../liquidity-providers/index.js'

import {
  http,
  Address,
  Hex,
  Log,
  RpcLog,
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  formatLog,
  numberToHex,
  parseAbiItem,
  toEventSelector,
} from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChainId } from '../../chain/constants.js'
import { Token } from '../../currency/index.js'
import { AerodromeSlipstreamProvider } from '../liquidity-providers/AerodromeSlipstream.js'
import { UniswapV2Provider } from '../liquidity-providers/UniswapV2.js'
import { UniswapV3Provider } from '../liquidity-providers/UniswapV3.js'
import { RainDataFetcher } from './RainDataFetcher.js'
import {
  RainDataFetcherStream,
  STREAM_HEAD_MARGIN,
  STREAM_READ_LAG_WARN,
  logId,
} from './RainDataFetcherStream.js'
import { RainV2Pool, UniV2EventsAbi } from './UniswapV2Base.js'
import { RainV3Pool, UniV3EventsAbi } from './UniswapV3Base.js'
import {
  DEFAULT_FEE_CONFIG,
  FeeType,
  SlipstreamPool,
} from './VelodromeSlipstreamBase.js'

// offline tests, no rpc calls are made
const client = createPublicClient({ transport: http('http://localhost:1') })
const WETH = new Token({
  chainId: ChainId.BASE,
  address: '0x4200000000000000000000000000000000000006',
  decimals: 18,
  symbol: 'WETH',
})
const USDC = new Token({
  chainId: ChainId.BASE,
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  decimals: 6,
  symbol: 'USDC',
})
const DAI = new Token({
  chainId: ChainId.BASE,
  address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  decimals: 18,
  symbol: 'DAI',
})

const POOL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
const POOL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address
const POOL_C = '0xcccccccccccccccccccccccccccccccccccccccc' as Address
const POOL_D = '0xdddddddddddddddddddddddddddddddddddddddd' as Address
const FEE_MODULE = '0xfeefeefeefeefeefeefeefeefeefeefeefeefee0' as Address
const NEW_MODULE = '0xfeefeefeefeefeefeefeefeefeefeefeefeefee1' as Address

const EVENTS = {
  swap: parseAbiItem(
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  ),
  mint: parseAbiItem(
    'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  ),
  sync: parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)'),
  customFeeSet: parseAbiItem(
    'event CustomFeeSet(address indexed pool, uint24 indexed fee)',
  ),
  scalingFactorSet: parseAbiItem(
    'event ScalingFactorSet(address indexed pool, uint256 indexed scalingFactor)',
  ),
  defaultFeeCapSet: parseAbiItem(
    'event DefaultFeeCapSet(uint256 indexed defaultFeeCap)',
  ),
  swapFeeModuleChanged: parseAbiItem(
    'event SwapFeeModuleChanged(address indexed oldFeeModule, address indexed newFeeModule)',
  ),
  poolCreated: parseAbiItem(
    'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
  ),
}

let nextTx = 1

/** builds a raw (hex fields) log with viem's encoders, each one its own tx */
function rawLog(
  address: Address,
  item: (typeof EVENTS)[keyof typeof EVENTS],
  args: Record<string, unknown>,
  blockNumber: bigint,
  tx: { hash?: Hex; index?: number; removed?: boolean } = {},
): RpcLog {
  const topics = encodeEventTopics({
    abi: [item],
    eventName: item.name,
    args,
  } as any).map((t) => t ?? (`0x${'0'.repeat(64)}` as Hex))
  const nonIndexed = item.inputs.filter((i) => !i.indexed)
  const data = nonIndexed.length
    ? encodeAbiParameters(
        nonIndexed,
        nonIndexed.map((i, idx) => args[i.name as string] ?? args[idx]),
      )
    : '0x'
  const hash =
    tx.hash ?? (`0x${(nextTx++).toString(16).padStart(64, '0')}` as Hex)
  return {
    address,
    topics,
    data,
    blockNumber: numberToHex(blockNumber),
    logIndex: numberToHex(tx.index ?? 0),
    transactionIndex: '0x0',
    blockHash: '0x',
    transactionHash: hash,
    removed: tx.removed ?? false,
  } as unknown as RpcLog
}

/** a Swap of the pool to the given price, it sets the liquidity to 7 */
const swap = (
  address: Address,
  price: bigint,
  blockNumber: bigint,
  tx?: { hash?: Hex; index?: number },
  tick = 0,
) =>
  rawLog(
    address,
    EVENTS.swap,
    {
      sender: address,
      recipient: address,
      amount0: 1n,
      amount1: -1n,
      sqrtPriceX96: price,
      liquidity: 7n,
      tick,
    },
    blockNumber,
    tx,
  )

/** a Mint around the active tick, it adds the amount to the liquidity */
const mint = (
  address: Address,
  amount: bigint,
  blockNumber: bigint,
  tx?: { hash?: Hex; index?: number; removed?: boolean },
) =>
  rawLog(
    address,
    EVENTS.mint,
    {
      sender: address,
      owner: address,
      tickLower: -10,
      tickUpper: 10,
      amount,
      amount0: 0n,
      amount1: 0n,
    },
    blockNumber,
    tx,
  )

const sync = (address: Address, reserve0: bigint, blockNumber: bigint) =>
  rawLog(address, EVENTS.sync, { reserve0, reserve1: 1n }, blockNumber)

const tick = () => new Promise((r) => setTimeout(r, 3))

/** waits until the condition holds, a chain of awaits can outlast one tick */
async function waitFor(condition: () => boolean, ms = 300) {
  const until = Date.now() + ms
  while (!condition() && Date.now() < until) await tick()
}

type Sub = {
  params: any[]
  onData: (data: any) => void
  onError: (error: unknown) => void
}

/** a v3 pool object as a provider fetch writes it */
const v3Pool = (address: Address, blockNumber: bigint) =>
  ({
    address,
    token0: WETH,
    token1: USDC,
    fee: 3000,
    sqrtPriceX96: 2n * 2n ** 96n,
    tick: 0,
    activeTick: 0,
    tickSpacing: 60,
    ticks: new Map(),
    liquidity: 1n,
    reserve0: 0n,
    reserve1: 0n,
    blockNumber,
  }) as unknown as RainV3Pool

type ParentFetch = (
  t0: unknown,
  t1: unknown,
  exclude: unknown,
  options: any,
) => Promise<void> | void

/** the parent fetch, one implementation per call, a no op when none is queued */
const parentFetch = vi.spyOn(RainDataFetcher.prototype, 'fetchPoolsForToken')
let parentImpls: ParentFetch[] = []
beforeEach(() => {
  parentImpls = []
  parentFetch.mockReset()
  parentFetch.mockImplementation(async (t0, t1, exclude, options) => {
    const impl = parentImpls.shift()
    if (impl) await impl(t0, t1, exclude, options)
  })
})

/**
 * a stream fetcher with one univ3 pool (A, block 10) and one univ2 pool
 * (B, block 12), no rpc: the ws subscribe, the head and the log read are
 * mocks. the read client's head follows the fed heads, less a lag
 */
function setup(options: { slipstream?: boolean } = {}) {
  const v3 = new UniswapV3Provider(ChainId.BASE, client)
  const v2 = new UniswapV2Provider(ChainId.BASE, client)
  // the follow up reads are rpc calls, the tests check they are asked
  v3.afterProcessLog = vi.fn(async () => {})
  v2.afterProcessLog = vi.fn(async () => {})
  // a slipstream provider with its fee module, its pools are written by fetches
  const slip = new AerodromeSlipstreamProvider(ChainId.BASE, client)
  slip.afterProcessLog = vi.fn(async () => {})
  slip.swapFeeModule[ChainId.BASE] = FEE_MODULE
  // the module defaults a live init reads: no scaling, a high fee cap, so
  // the pools are not volatile and their fee resolves from the settings
  slip.defaultScalingFactor[ChainId.BASE] = 0n
  slip.defaultFeeCap[ChainId.BASE] = 1_000_000n
  const poolA = {
    address: POOL_A,
    token0: WETH,
    token1: USDC,
    fee: 500,
    sqrtPriceX96: 2n * 2n ** 96n,
    tick: 0,
    activeTick: 0,
    tickSpacing: 10,
    ticks: new Map(),
    liquidity: 1n,
    reserve0: 0n,
    reserve1: 0n,
    blockNumber: 10n,
  } as unknown as RainV3Pool
  const poolB = {
    address: POOL_B,
    token0: WETH,
    token1: USDC,
    fee: 30,
    reserve0: 10n,
    reserve1: 40n,
    blockNumber: 12n,
  } as unknown as RainV2Pool
  v3.pools.set(POOL_A, poolA)
  v2.pools.set(POOL_B, poolB)
  const fetcher = new RainDataFetcherStream(ChainId.BASE, client)
  // the logs the read serves, filtered by the asked range and addresses
  const readable: Log[] = []
  let failReads = 0
  let failSliceFrom: bigint | undefined
  let holdReads: ((value: Log[]) => void)[] | undefined
  const getLogs = vi.fn(async (args: any) => {
    if (failReads > 0) {
      failReads--
      throw new Error('read failed')
    }
    if (failSliceFrom !== undefined && args.fromBlock === failSliceFrom) {
      failSliceFrom = undefined
      throw new Error('slice failed')
    }
    const logs = readable.filter(
      (log) =>
        log.blockNumber! >= args.fromBlock &&
        log.blockNumber! <= args.toBlock &&
        args.address.includes(log.address.toLowerCase()),
    )
    if (holdReads)
      return new Promise<Log[]>((r) => holdReads!.push(() => r(logs)))
    return logs
  })
  const chain = { head: 15n, lag: 0n }
  const getBlockNumber = vi.fn(async () => chain.head - chain.lag)
  Object.assign(fetcher, {
    providers: options.slipstream ? [v3, v2, slip] : [v3, v2],
    web3Client: { getBlockNumber, getLogs },
    eventsAbi: [
      ...UniV3EventsAbi,
      ...UniV2EventsAbi,
      ...(options.slipstream ? (slip.eventsAbi as any[]) : []),
    ],
    factories: [
      v3.factory[ChainId.BASE]!.toLowerCase(),
      v2.factory[ChainId.BASE]!.toLowerCase(),
      ...(options.slipstream
        ? [slip.factory[ChainId.BASE]!.toLowerCase()]
        : []),
    ],
  })
  const unsubscribe = vi.fn(async () => true)
  const subs: Sub[] = []
  const subscribe = vi.fn(async (args: Sub) => {
    subs.push(args)
    return { subscriptionId: `0x${subs.length}`, unsubscribe }
  })
  const wsClient = { transport: { subscribe } } as any
  const last = (kind: 'newHeads' | 'newFlashblocks' | 'logs' | 'pendingLogs') =>
    [...subs].reverse().find((s) => s.params[0] === kind)!
  /** feeds a sealed head: a newHeads frame, or with flashblocks the first flashblock of the next block */
  const feedHead = (number: bigint) => {
    if (number > chain.head) chain.head = number
    if (fetcher.flashblocks) {
      last('newFlashblocks').onData({
        result: { number: numberToHex(number + 1n) },
      })
    } else {
      last('newHeads').onData({ result: { number: numberToHex(number) } })
    }
  }
  const feedLog = (raw: RpcLog, kind: 'logs' | 'pendingLogs' = 'logs') =>
    last(kind).onData({ result: raw })
  /** the log is served by the read as well, as the node would */
  const readable_ = (raw: RpcLog) => {
    readable.push(formatLog(raw) as Log)
    return raw
  }
  /** a subscribe call that waits until released */
  const slowSubscribe = () => {
    let release!: (sub: any) => void
    subscribe.mockImplementationOnce(
      (args: Sub) =>
        new Promise((r) => {
          subs.push(args)
          release = r
        }),
    )
    return () => release({ subscriptionId: '0xslow', unsubscribe })
  }
  /**
   * a parent fetch that writes pool C at the fetch block (plus the offset).
   * a slow one waits until released, and a late one writes only then
   */
  const writesC = (offset = 0n, slow = false, late = false) => {
    let release!: () => void
    const impl: ParentFetch = (_t0, _t1, _e, options) => {
      const write = () =>
        v3.pools.set(POOL_C, v3Pool(POOL_C, options.blockNumber + offset))
      if (!late) write()
      if (!slow) return
      return new Promise<void>((r) => {
        release = () => {
          if (late) write()
          r()
        }
      })
    }
    parentImpls.push(impl)
    return () => release()
  }
  /** a parent fetch that writes the slipstream pool D at the fetch block */
  const writesD = () => {
    parentImpls.push((_t0, _t1, _e, options) => {
      // a custom base fee of 500 is set on the module for D
      slip.pools.set(POOL_D, {
        ...v3Pool(POOL_D, options.blockNumber),
        address: POOL_D,
        tickSpacing: 100,
        fee: 500,
        feeType: FeeType.Dynamic,
        feeConfig: { ...DEFAULT_FEE_CONFIG, baseFee: 500 },
      } as unknown as SlipstreamPool)
    })
  }
  return {
    fetcher,
    v3,
    v2,
    poolA,
    poolB,
    readable,
    readable_,
    getLogs,
    getBlockNumber,
    chain,
    subs,
    subscribe,
    unsubscribe,
    wsClient,
    feedHead,
    last,
    feedLog,
    slowSubscribe,
    writesC,
    writesD,
    slip,
    failReads: (n: number) => {
      failReads = n
    },
    failSlice: (from: bigint) => {
      failSliceFrom = from
    },
    holdReads: () => {
      holdReads = []
      return () => {
        const held = holdReads!
        holdReads = undefined
        held.forEach((r) => r([]))
      }
    },
  }
}

/** starts the stream and settles its first read at head 17 */
async function started(s: ReturnType<typeof setup>, flashblocks = false) {
  const starting = s.fetcher.start(s.wsClient, {
    flashblocks,
    resubscribeDelay: 1,
    stallTimeout: 0,
  })
  await tick()
  s.feedHead(15n + STREAM_HEAD_MARGIN)
  await starting
  return starting
}

describe('RainDataFetcherStream onPoolChange', () => {
  /** a Swap of the pool with the given amounts, the signs tell the direction */
  const swapWith = (
    address: Address,
    amount0: bigint,
    amount1: bigint,
    blockNumber: bigint,
    index = 0,
  ) =>
    rawLog(
      address,
      EVENTS.swap,
      {
        sender: address,
        recipient: address,
        amount0,
        amount1,
        sqrtPriceX96: 3n * 2n ** 96n,
        liquidity: 7n,
        tick: 0,
      },
      blockNumber,
      { index },
    )
  /** a Sync of the pool to the given reserves */
  const syncTo = (
    address: Address,
    reserves: [bigint, bigint],
    blockNumber: bigint,
    index = 0,
  ) =>
    rawLog(
      address,
      EVENTS.sync,
      { reserve0: reserves[0], reserve1: reserves[1] },
      blockNumber,
      { index },
    )
  /** starts the stream with the callbacks and settles its first read at head 17 */
  async function startedWith(
    s: ReturnType<typeof setup>,
    onPoolChange: (...args: any[]) => void,
    onPoolsChange?: (...args: any[]) => void,
  ) {
    const starting = s.fetcher.start(s.wsClient, {
      resubscribeDelay: 1,
      stallTimeout: 0,
      onPoolChange,
      onPoolsChange,
    })
    await tick()
    s.feedHead(15n + STREAM_HEAD_MARGIN)
    await starting
  }

  it('hands each live swap of a cached pool on as it applies, with the direction off the amounts', async () => {
    const s = setup()
    const calls: string[] = []
    const onPoolChange = vi.fn(() => calls.push('log'))
    const onPoolsChange = vi.fn(() => calls.push('batch'))
    await startedWith(s, onPoolChange, onPoolsChange)
    // the pool received token0, paid token1, the other way round, a swap of nothing
    s.feedLog(swapWith(POOL_A, 5n, -3n, 18n))
    s.feedLog(swapWith(POOL_A, -5n, 3n, 18n, 1))
    s.feedLog(swapWith(POOL_A, 0n, 0n, 18n, 2))
    expect(onPoolChange).toHaveBeenCalledTimes(3)
    expect(onPoolChange.mock.calls.map((c: any[]) => c[2])).toEqual([
      true,
      false,
      undefined,
    ])
    // the pool address lower cased and the formatted log, its fields decoded
    const [address, log] = onPoolChange.mock.calls[0] as any[]
    expect(address).toBe(POOL_A)
    expect(log.blockNumber).toBe(18n)
    expect(log.logIndex).toBe(0)
    expect(log.address).toBe(POOL_A)
    // the log applied before the call, the pool is at the swap's price
    expect(s.poolA.sqrtPriceX96).toBe(3n * 2n ** 96n)
    // the per log calls come as the logs arrive, the batch report after them
    await tick()
    expect(onPoolsChange).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['log', 'log', 'log', 'batch'])
  })

  it('hands a live sync on with the direction off the change against the reserves the pool holds', async () => {
    const s = setup()
    const onPoolChange = vi.fn()
    await startedWith(s, onPoolChange)
    // pool B holds 10 and 40: reserve0 up and reserve1 down is a buy of token1
    s.feedLog(syncTo(POOL_B, [12n, 30n], 18n))
    expect(s.poolB.reserve0).toBe(12n)
    // the other way round, against the reserves the first sync set
    s.feedLog(syncTo(POOL_B, [11n, 33n], 18n, 1))
    // both up, a mint, both down, a burn, the same again: no direction
    s.feedLog(syncTo(POOL_B, [13n, 39n], 19n))
    s.feedLog(syncTo(POOL_B, [12n, 36n], 19n, 1))
    s.feedLog(syncTo(POOL_B, [12n, 36n], 19n, 2))
    expect(onPoolChange.mock.calls.map((c: any[]) => c[2])).toEqual([
      true,
      false,
      undefined,
      undefined,
      undefined,
    ])
    expect(onPoolChange.mock.calls.every((c: any[]) => c[0] === POOL_B)).toBe(
      true,
    )
  })

  it('hands a log on once, a repeat of it and other logs are not handed on', async () => {
    const s = setup()
    const onPoolChange = vi.fn()
    await startedWith(s, onPoolChange)
    const raw = swapWith(POOL_A, 5n, -3n, 18n)
    s.feedLog(raw)
    s.feedLog(raw)
    expect(onPoolChange).toHaveBeenCalledTimes(1)
    // a mint moves the liquidity, not the price, it is applied and not handed on
    s.feedLog(mint(POOL_A, 5n, 18n))
    expect(s.poolA.liquidity).toBe(12n)
    // a swap of a pool the stream does not hold is held, not applied, not handed on
    s.feedLog(swapWith(POOL_C, 5n, -3n, 18n))
    expect(onPoolChange).toHaveBeenCalledTimes(1)
  })

  it('does not hand on the logs a read brings nor a held log replayed after it', async () => {
    const s = setup()
    const onPoolChange = vi.fn()
    const starting = s.fetcher.start(s.wsClient, {
      resubscribeDelay: 1,
      stallTimeout: 0,
      onPoolChange,
    })
    await tick()
    // before the first read settles every log is held, this one is replayed
    // after the read, and the read itself brings a swap of pool B
    s.readable_(syncTo(POOL_B, [12n, 30n], 16n))
    s.feedLog(swapWith(POOL_A, 5n, -3n, 18n))
    s.feedHead(15n + STREAM_HEAD_MARGIN)
    await starting
    await tick()
    expect(s.poolA.sqrtPriceX96).toBe(3n * 2n ** 96n)
    expect(s.poolB.reserve0).toBe(12n)
    expect(onPoolChange).not.toHaveBeenCalled()
    // the stream is live from here, the next swap is handed on
    s.feedLog(swapWith(POOL_A, -5n, 3n, 19n))
    expect(onPoolChange).toHaveBeenCalledTimes(1)
    expect(onPoolChange.mock.calls[0]![2]).toBe(false)
  })

  it('reports a throwing callback and goes on, the log applied and the batch reported', async () => {
    const s = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onPoolChange = vi.fn(() => {
      throw new Error('boom')
    })
    const onPoolsChange = vi.fn()
    await startedWith(s, onPoolChange, onPoolsChange)
    s.feedLog(swapWith(POOL_A, 5n, -3n, 18n))
    expect(onPoolChange).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('pools stream callback failed'),
    )
    expect(s.poolA.sqrtPriceX96).toBe(3n * 2n ** 96n)
    await tick()
    expect(onPoolsChange).toHaveBeenCalledWith([POOL_A], 18n)
    warn.mockRestore()
  })
})

describe('RainDataFetcherStream.start', () => {
  it('subscribes newHeads and logs on the factories and every pool with every topic', async () => {
    const s = setup()
    await started(s)
    expect(s.subs[0]!.params).toEqual(['newHeads'])
    const [method, filter] = s.subs[1]!.params
    expect(method).toBe('logs')
    expect(filter.address).toEqual([...s.fetcher.factories, POOL_A, POOL_B])
    expect(filter.topics).toEqual([
      s.fetcher.eventsAbi.map((e) => toEventSelector(e as any)),
    ])
    expect(s.fetcher.subscribed).toEqual(new Set([POOL_A, POOL_B]))
    expect(s.fetcher.admitted).toEqual(
      new Map([
        [POOL_A, s.poolA],
        [POOL_B, s.poolB],
      ]),
    )
    expect(s.fetcher.open).toBe(true)
    // flashblocks subscribes newFlashblocks and pendingLogs
    const fb = setup()
    await started(fb, true)
    expect(fb.subs[0]!.params).toEqual(['newFlashblocks'])
    expect(fb.subs[1]!.params[0]).toBe('pendingLogs')
  })

  it('reads the gap from each pool its own block to the head once the margin passed, holding the stream meanwhile', async () => {
    const s = setup()
    // served by the read: a log at pool B's own block is in its state already
    s.readable_(swap(POOL_A, 3n * 2n ** 96n, 11n))
    s.readable_(sync(POOL_B, 20n, 12n))
    s.readable_(sync(POOL_B, 30n, 14n))
    const starting = s.fetcher.start(s.wsClient, { stallTimeout: 0 })
    await tick()
    // open at 15, the read waits for head 17
    expect(s.fetcher.holdingAll).toBe(true)
    expect(s.getLogs).not.toHaveBeenCalled()
    s.feedHead(16n)
    await tick()
    expect(s.getLogs).not.toHaveBeenCalled()
    // the stream serves a log of block 16 (the read serves it too) and a
    // Mint of block 18, ahead of the read, both held
    s.feedLog(s.readable_(mint(POOL_A, 5n, 16n)))
    s.feedLog(mint(POOL_A, 4n, 18n))
    expect(s.fetcher.held.length).toBe(2)
    expect(s.poolA.liquidity).toBe(1n)
    // the read runs from the oldest pool's block, exclusive, to the head
    s.readable_(mint(POOL_A, 100n, 17n))
    s.feedHead(17n)
    await starting
    expect(s.getLogs).toHaveBeenCalledTimes(1)
    expect(s.getLogs.mock.calls[0]![0]).toMatchObject({
      fromBlock: 11n,
      toBlock: 17n,
      address: [...s.fetcher.factories, POOL_A, POOL_B],
      events: s.fetcher.eventsAbi,
    })
    // pool A: the swap sets the liquidity (7), the read Mints add 5 and
    // 100, then the held Mint of block 18 adds 4: the held one of block 16
    // was applied by the read already
    expect(s.poolA.sqrtPriceX96).toBe(3n * 2n ** 96n)
    expect(s.poolA.liquidity).toBe(7n + 5n + 100n + 4n)
    // pool B: the log at its own block 12 was skipped, the one at 14 landed
    expect(s.poolB.reserve0).toBe(30n)
    expect(s.poolA.blockNumber).toBe(18n)
    expect(s.poolB.blockNumber).toBe(17n)
    expect(s.fetcher.complete.get(POOL_A)).toBe(17n)
    expect(s.fetcher.holdingAll).toBe(false)
    expect(s.fetcher.held).toEqual([])
    expect(s.fetcher.gaps).toEqual([])
    // the follow up reads ran at the read's end block
    expect(s.v3.afterProcessLog).toHaveBeenCalledWith(17n)
  })

  it('keeps the gap open and the holds on when the read fails, the next head tries again', async () => {
    const s = setup()
    s.failReads(1)
    s.readable_(sync(POOL_B, 30n, 14n))
    const starting = s.fetcher.start(s.wsClient, { stallTimeout: 0 })
    await tick()
    let resolved = false
    starting.then(() => {
      resolved = true
    })
    s.feedHead(17n)
    await tick()
    expect(s.getLogs).toHaveBeenCalledTimes(1)
    expect(resolved).toBe(false)
    expect(s.fetcher.holdingAll).toBe(true)
    expect(s.fetcher.gaps.length).toBe(1)
    expect(s.poolB.reserve0).toBe(10n)
    s.feedHead(18n)
    await starting
    expect(s.getLogs).toHaveBeenCalledTimes(2)
    expect(s.getLogs.mock.calls[1]![0].toBlock).toBe(18n)
    expect(s.poolB.reserve0).toBe(30n)
    expect(s.fetcher.holdingAll).toBe(false)
  })

  it('waits for the read client when it is behind the socket, the gap is read once the client reached the stream start', async () => {
    const s = setup()
    s.readable_(sync(POOL_B, 30n, 16n))
    s.readable_(sync(POOL_B, 40n, 17n))
    const starting = s.fetcher.start(s.wsClient, { stallTimeout: 0 })
    await tick()
    // the read client sits one block behind the socket
    s.chain.lag = 1n
    s.feedHead(17n)
    await tick()
    // the client at 16 is short of the stream start at 17: no read, the gap stays
    expect(s.getLogs).not.toHaveBeenCalled()
    expect(s.fetcher.holdingAll).toBe(true)
    expect(s.fetcher.gaps.length).toBe(1)
    expect(s.poolB.reserve0).toBe(10n)
    s.feedHead(18n)
    await starting
    // one read up to the client's head 17
    expect(s.getLogs).toHaveBeenCalledTimes(1)
    expect(s.getLogs.mock.calls[0]![0]).toMatchObject({
      fromBlock: 11n,
      toBlock: 17n,
    })
    expect(s.poolB.reserve0).toBe(40n)
    expect(s.fetcher.complete.get(POOL_B)).toBe(17n)
    expect(s.fetcher.holdingAll).toBe(false)
  })

  it('warns once while the read client is far behind the socket, a read clears the warning', async () => {
    const s = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const starting = s.fetcher.start(s.wsClient, { stallTimeout: 0 })
      await tick()
      s.chain.lag = STREAM_READ_LAG_WARN
      s.feedHead(17n)
      await tick()
      s.feedHead(18n)
      await tick()
      const waits = () =>
        warn.mock.calls.filter((c) =>
          String(c[0]).includes('waits for the read client'),
        )
      expect(waits()).toEqual([
        [
          'pools gap read waits for the read client, it is at block 7, the stream is at block 17',
        ],
      ])
      expect(s.getLogs).not.toHaveBeenCalled()
      s.chain.lag = 0n
      s.feedHead(19n)
      await starting
      expect(s.fetcher.lagWarned).toBe(false)
      expect(waits().length).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not move a pool ahead of a read that stopped short', async () => {
    const s = setup()
    s.poolA.blockNumber = 1500n
    s.chain.head = 2500n
    s.readable_(mint(POOL_A, 100n, 1500n))
    s.failSlice(1013n)
    const starting = s.fetcher.start(s.wsClient, { stallTimeout: 0 })
    await tick()
    s.feedHead(2502n)
    await tick()
    // the slices run from B's block 12: the first landed, the second failed
    expect(s.fetcher.complete.get(POOL_B)).toBe(1012n)
    expect(s.fetcher.complete.get(POOL_A)).toBe(1500n)
    expect(s.poolA.blockNumber).toBe(1500n)
    s.feedHead(2503n)
    await starting
    // A's Mint of 1500 is in its state, it was not applied again
    expect(s.poolA.liquidity).toBe(1n)
    expect(s.fetcher.complete.get(POOL_A)).toBe(2503n)
  })

  it('keeps a read that stopped at a failed slice and goes on from there', async () => {
    const s = setup()
    // pool A at 10, the chain at 2500: three slices, the second one fails
    s.chain.head = 2500n
    s.readable_(mint(POOL_A, 5n, 500n))
    s.readable_(mint(POOL_A, 6n, 1500n))
    s.failSlice(1011n)
    const starting = s.fetcher.start(s.wsClient, { stallTimeout: 0 })
    await tick()
    s.feedHead(2502n)
    await tick()
    const ranges = (from: number) =>
      s.getLogs.mock.calls
        .slice(from)
        .map((c) => [c[0].fromBlock, c[0].toBlock])
    expect(ranges(0)).toEqual([
      [11n, 1010n],
      [1011n, 2010n],
      [2011n, 2502n],
    ])
    // the first slice landed, the pools are complete through it
    expect(s.poolA.liquidity).toBe(6n)
    expect(s.fetcher.complete.get(POOL_A)).toBe(1010n)
    expect(s.fetcher.holdingAll).toBe(true)
    s.feedHead(2503n)
    await starting
    expect(ranges(3)).toEqual([
      [1011n, 2010n],
      [2011n, 2503n],
    ])
    expect(s.poolA.liquidity).toBe(12n)
    expect(s.fetcher.complete.get(POOL_A)).toBe(2503n)
  })

  it('holds every log and keeps the pools still from the first subscription on', async () => {
    const s = setup()
    // the logs subscription takes a while, a head comes in meanwhile
    s.subscribe.mockImplementationOnce(async (args: Sub) => {
      s.subs.push(args)
      return { subscriptionId: '0x1', unsubscribe: s.unsubscribe }
    })
    const release = s.slowSubscribe()
    const starting = s.fetcher.start(s.wsClient, { stallTimeout: 0 })
    await tick()
    expect(s.fetcher.holdingAll).toBe(true)
    s.feedHead(30n)
    // not proven: the logs of (10, 28] were never served
    expect(s.poolA.blockNumber).toBe(10n)
    expect(s.fetcher.complete.get(POOL_A)).toBe(10n)
    release()
    await tick()
    // open at head 30, the read waits for 32 and covers from each pool's block
    expect(s.fetcher.openedAt).toBe(30n)
    expect(s.fetcher.gaps).toEqual([{ pools: undefined, readyAt: 32n }])
    s.readable_(sync(POOL_B, 30n, 14n))
    s.feedHead(32n)
    await starting
    expect(s.getLogs.mock.calls[0]![0]).toMatchObject({
      fromBlock: 11n,
      toBlock: 32n,
    })
    expect(s.poolB.reserve0).toBe(30n)
    expect(s.poolA.blockNumber).toBe(32n)
  })

  it('resolves through the reopen when the node never answers the first heads subscribe', async () => {
    const s = setup()
    s.subscribe.mockImplementationOnce(
      (args: Sub) =>
        new Promise(() => {
          s.subs.push(args)
        }),
    )
    // the stall drops the dead open, the reopen answers, the first read runs
    const starting = s.fetcher.start(s.wsClient, {
      resubscribeDelay: 1,
      stallTimeout: 10,
    })
    await waitFor(() => s.fetcher.open)
    expect(s.fetcher.drops).toBeGreaterThanOrEqual(1)
    s.feedHead(17n)
    await starting
    expect(s.fetcher.holdingAll).toBe(false)
    // the dead open's late failure is nothing to the stream that is up
    await new Promise((r) => setTimeout(r, 20))
    expect(s.fetcher.open).toBe(true)
    await s.fetcher.stop()
  })

  it('cleans up when the open fails after the heads subscription', async () => {
    const s = setup()
    s.subscribe.mockImplementationOnce(async (args: Sub) => {
      s.subs.push(args)
      return { subscriptionId: '0x1', unsubscribe: s.unsubscribe }
    })
    s.subscribe.mockRejectedValueOnce(new Error('logs refused'))
    await expect(
      s.fetcher.start(s.wsClient, { stallTimeout: 0 }),
    ).rejects.toThrow('logs refused')
    // the heads subscription went with it
    expect(s.unsubscribe).toHaveBeenCalledTimes(1)
    expect(s.fetcher.wsClient).toBeUndefined()
    expect(s.fetcher.headsSubscription).toBeUndefined()
    expect(s.fetcher.holdingAll).toBe(false)
    expect(s.fetcher.gaps).toEqual([])
    // a start after that works
    await started(s)
    expect(s.fetcher.open).toBe(true)
  })

  it('drops what a stopped open put up, and the start throws', async () => {
    const s = setup()
    s.subscribe.mockImplementationOnce(async (args: Sub) => {
      s.subs.push(args)
      return { subscriptionId: '0x1', unsubscribe: s.unsubscribe }
    })
    const release = s.slowSubscribe()
    const starting = s.fetcher.start(s.wsClient, { stallTimeout: 0 })
    await tick()
    await s.fetcher.stop()
    // the heads subscription was dropped by the stop
    expect(s.unsubscribe).toHaveBeenCalledTimes(1)
    release()
    await expect(starting).rejects.toThrow('stopped')
    // the late logs subscription is dropped, nothing stays open or held
    expect(s.unsubscribe).toHaveBeenCalledTimes(2)
    expect(s.fetcher.subscription).toBeUndefined()
    expect(s.fetcher.open).toBe(false)
    expect(s.fetcher.holdingAll).toBe(false)
    expect(s.fetcher.gaps).toEqual([])
    // a start after that works
    await started(s)
    expect(s.fetcher.open).toBe(true)
  })

  it('leaves a new start alone when a read of the stopped one ends late', async () => {
    const s = setup()
    const releaseReads = s.holdReads()
    const first = s.fetcher.start(s.wsClient, { stallTimeout: 0 })
    await tick()
    s.feedHead(17n)
    await tick()
    expect(s.getLogs).toHaveBeenCalledTimes(1)
    await s.fetcher.stop()
    await expect(first).rejects.toThrow('stopped')
    const second = s.fetcher.start(s.wsClient, { stallTimeout: 0 })
    await tick()
    let resolved = false
    second.then(() => {
      resolved = true
    })
    // the old read ends now: the new stream stays held, waiting for its own
    releaseReads()
    await tick()
    expect(resolved).toBe(false)
    expect(s.fetcher.holdingAll).toBe(true)
    expect(s.fetcher.complete.get(POOL_A)).toBe(10n)
    s.feedHead(19n)
    await second
    expect(s.getLogs).toHaveBeenCalledTimes(2)
    expect(s.fetcher.complete.get(POOL_A)).toBe(19n)
  })

  it('throws and leaves nothing running when the socket fails during the first subscribe', async () => {
    const s = setup()
    s.subscribe.mockImplementationOnce(async (args: Sub) => {
      s.subs.push(args)
      return { subscriptionId: '0x1', unsubscribe: s.unsubscribe }
    })
    // viem reports a socket failure to onError and rejects the subscribe
    s.subscribe.mockImplementationOnce(async (args: Sub) => {
      s.subs.push(args)
      args.onError(new Error('socket closed'))
      throw new Error('socket closed')
    })
    await expect(
      s.fetcher.start(s.wsClient, { resubscribeDelay: 1, stallTimeout: 0 }),
    ).rejects.toThrow('socket closed')
    expect(s.fetcher.wsClient).toBeUndefined()
    expect(s.fetcher.drops).toBe(0)
    await new Promise((r) => setTimeout(r, 10))
    // and no reopen runs in the background
    expect(s.subs.length).toBe(2)
    expect(s.fetcher.open).toBe(false)
  })

  it('admits the pools of a fetch that began before the start once it ends', async () => {
    const s = setup()
    // the fetch writes its pool only when it ends, after the start
    const release = s.writesC(0n, true, true)
    const fetching = s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 15n,
    })
    await tick()
    await started(s)
    expect(s.v3.pools.has(POOL_C)).toBe(false)
    release()
    await fetching
    await tick()
    expect(s.fetcher.admitted.get(POOL_C)).toBe(s.v3.pools.get(POOL_C))
    expect(s.fetcher.complete.get(POOL_C)).toBe(15n)
    expect(s.fetcher.subscribed.has(POOL_C)).toBe(true)
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_C]), readyAt: 19n }])
  })

  it('throws without a websocket client and cannot start twice', async () => {
    const s = setup()
    await expect(s.fetcher.start({ transport: {} } as any)).rejects.toThrow(
      'websocket',
    )
    expect(s.fetcher.wsClient).toBeUndefined()
    await started(s)
    await expect(s.fetcher.start(s.wsClient)).rejects.toThrow('already')
  })
})

describe('RainDataFetcherStream log handling', () => {
  it('applies a stream log in full mode: the change is reported at once, the ticks a Swap queued are read at the next head', async () => {
    const s = setup()
    const onPoolsChange = vi.fn()
    const starting = s.fetcher.start(s.wsClient, {
      flashblocks: true,
      stallTimeout: 0,
      onPoolsChange,
    })
    await tick()
    s.feedHead(17n)
    await starting
    ;(s.v3.afterProcessLog as any).mockClear()
    ;(s.v2.afterProcessLog as any).mockClear()
    // a pending Swap of block 18 crossing to tick 100, its words are unread
    s.feedLog(swap(POOL_A, 5n * 2n ** 96n, 18n, undefined, 100), 'pendingLogs')
    expect(s.poolA.sqrtPriceX96).toBe(5n * 2n ** 96n)
    expect(s.poolA.blockNumber).toBe(18n)
    expect(s.v3.newTicksQueue.length).toBe(1)
    await tick()
    expect(onPoolsChange).toHaveBeenCalledTimes(1)
    expect(onPoolsChange).toHaveBeenCalledWith([POOL_A], 18n)
    // no read of its own, the next head's run reads the queued ticks, at
    // the sealed head since the pending block cannot be read
    expect(s.v3.afterProcessLog).not.toHaveBeenCalled()
    s.feedHead(18n)
    await tick()
    expect(s.v3.afterProcessLog).toHaveBeenCalledWith(18n, new Set([POOL_A]))
    // the v2 provider had no log since its last run, nothing to read
    expect(s.v2.afterProcessLog).not.toHaveBeenCalled()
  })

  it('runs every provider over every pool at each head with followUpTouchedOnly off', async () => {
    const s = setup()
    const starting = s.fetcher.start(s.wsClient, {
      resubscribeDelay: 1,
      stallTimeout: 0,
      followUpTouchedOnly: false,
    })
    await tick()
    s.feedHead(15n + STREAM_HEAD_MARGIN)
    await starting
    ;(s.v3.afterProcessLog as any).mockClear()
    ;(s.v2.afterProcessLog as any).mockClear()
    // no log at all: both providers still run, over every pool
    s.feedHead(18n)
    await tick()
    expect(s.v3.afterProcessLog).toHaveBeenCalledWith(18n, undefined)
    expect(s.v2.afterProcessLog).toHaveBeenCalledWith(18n, undefined)
    // a log of one pool changes nothing about the scope
    s.feedLog(swap(POOL_A, 5n * 2n ** 96n, 19n))
    s.feedHead(19n)
    await tick()
    expect(s.v3.afterProcessLog).toHaveBeenLastCalledWith(19n, undefined)
    expect(s.v2.afterProcessLog).toHaveBeenLastCalledWith(19n, undefined)
  })

  it('widens the scope to every pool of a slipstream provider on a module wide log', async () => {
    const s = setup({ slipstream: true })
    await started(s)
    ;(s.slip.afterProcessLog as any).mockClear()
    s.feedLog(
      rawLog(
        FEE_MODULE,
        EVENTS.defaultFeeCapSet,
        { defaultFeeCap: 1_000_000n },
        18n,
      ),
    )
    s.feedHead(18n)
    await tick()
    expect(s.slip.afterProcessLog).toHaveBeenCalledTimes(1)
    expect(s.slip.afterProcessLog).toHaveBeenCalledWith(18n, undefined)
    // the other providers had no log, nothing runs for them
    expect(s.v3.afterProcessLog).toHaveBeenCalledTimes(1)
    expect(s.v3.afterProcessLog).toHaveBeenCalledWith(17n)
  })

  it('tries the tick words of a failed read again at the next head, a log need not touch the provider', async () => {
    const s = setup()
    await started(s)
    ;(s.v3.afterProcessLog as any).mockClear()
    // the mock reads nothing, so the queued words stay queued as after a
    // failed read
    s.feedLog(swap(POOL_A, 5n * 2n ** 96n, 18n))
    expect(s.v3.newTicksQueue.length).toBe(1)
    s.feedHead(18n)
    await tick()
    expect(s.v3.afterProcessLog).toHaveBeenCalledTimes(1)
    s.feedHead(19n)
    await tick()
    expect(s.v3.afterProcessLog).toHaveBeenCalledTimes(2)
    // work left from its last run marks it again, with no pool to re-read
    expect(s.v3.afterProcessLog).toHaveBeenLastCalledWith(19n, new Set())
    // the read lands: the queue drains and the provider rests
    ;(s.v3.afterProcessLog as any).mockImplementationOnce(async () => {
      s.v3.newTicksQueue.splice(0)
    })
    s.feedHead(20n)
    await tick()
    expect(s.v3.afterProcessLog).toHaveBeenCalledTimes(3)
    s.feedHead(21n)
    await tick()
    expect(s.v3.afterProcessLog).toHaveBeenCalledTimes(3)
  })

  it("takes the flashblock's block less one as the sealed head", async () => {
    const s = setup()
    await started(s, true)
    expect(s.fetcher.head).toBe(17n)
    // the first flashblock of block 20 seals block 19
    s.last('newFlashblocks').onData({ result: { number: numberToHex(20n) } })
    expect(s.fetcher.head).toBe(19n)
    // a flashblock of block 0 seals nothing, a frame without a number is dropped
    s.last('newFlashblocks').onData({ result: { number: numberToHex(0n) } })
    s.last('newFlashblocks').onData({ result: {} })
    expect(s.fetcher.head).toBe(19n)
  })

  it('applies a log once: the same id from the stream twice, or from the read and the stream', async () => {
    const s = setup()
    await started(s)
    const first = mint(POOL_A, 5n, 18n)
    s.feedLog(first)
    s.feedLog(first)
    expect(s.poolA.liquidity).toBe(6n)
    // another log of the same tx, another index, is another log
    s.feedLog(mint(POOL_A, 2n, 18n, { hash: first.transactionHash, index: 1 }))
    expect(s.poolA.liquidity).toBe(8n)
    // a removed log is not applied
    s.feedLog(mint(POOL_A, 50n, 18n, { removed: true }))
    expect(s.poolA.liquidity).toBe(8n)
    expect(logId(formatLog(first) as Log)).toBe(`${first.transactionHash}:0`)
  })

  it('holds nothing while a follow up read runs, the logs keep applying and are reported at once', async () => {
    const s = setup()
    const onPoolsChange = vi.fn()
    const starting = s.fetcher.start(s.wsClient, {
      resubscribeDelay: 1,
      stallTimeout: 0,
      onPoolsChange,
    })
    await tick()
    s.feedHead(15n + STREAM_HEAD_MARGIN)
    await starting
    // the read of the queued words waits until released
    let release!: () => void
    s.v3.afterProcessLog = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    // a Swap queues the words around its tick, none is cached yet
    s.feedLog(swap(POOL_A, 5n * 2n ** 96n, 18n))
    expect(s.v3.newTicksQueue.length).toBe(1)
    s.feedHead(18n)
    await tick()
    expect(s.v3.afterProcessLog).toHaveBeenCalledWith(18n, new Set([POOL_A]))
    expect(s.fetcher.holding.size).toBe(0)
    onPoolsChange.mockClear()
    // A's Mint applies while the read runs, as B's Sync does, the provider
    // adds what fell into the fetched words back when the read lands
    s.feedLog(mint(POOL_A, 5n, 19n))
    s.feedLog(sync(POOL_B, 30n, 19n))
    expect(s.poolA.liquidity).toBe(12n)
    expect(s.poolB.reserve0).toBe(30n)
    expect(s.fetcher.held).toEqual([])
    await tick()
    expect(onPoolsChange).toHaveBeenCalledTimes(1)
    expect(onPoolsChange).toHaveBeenCalledWith([POOL_A, POOL_B], 19n)
    release()
    await tick()
    expect(s.poolA.liquidity).toBe(12n)
    expect(s.fetcher.holding.size).toBe(0)
  })

  it('moves the idle pools up to the proven block on a head and prunes the ids', async () => {
    const s = setup()
    await started(s)
    // the start's read asked every provider, the heads below ask the touched
    ;(s.v2.afterProcessLog as any).mockClear()
    s.feedLog(swap(POOL_A, 5n * 2n ** 96n, 18n))
    expect(s.fetcher.applied.get(POOL_A)!.size).toBe(1)
    // head 25 proves block 23: pool B had no log, it moves up to it. the
    // head's follow up reads A's queued words, it ends in a tick
    s.feedHead(25n)
    await tick()
    expect(s.poolB.blockNumber).toBe(23n)
    expect(s.fetcher.complete.get(POOL_B)).toBe(23n)
    expect(s.poolA.blockNumber).toBe(23n)
    expect(s.fetcher.applied.has(POOL_A)).toBe(false)
    // a pool ahead of the proven block stays where its logs put it, the
    // logs of a sealed block can land before its head
    s.feedLog(swap(POOL_A, 6n * 2n ** 96n, 27n))
    s.feedHead(26n)
    expect(s.poolA.blockNumber).toBe(27n)
    expect(s.fetcher.complete.get(POOL_A)).toBe(24n)
    // a late log of a proven block is not applied, nor an older head
    s.feedLog(sync(POOL_B, 99n, 23n))
    expect(s.poolB.reserve0).toBe(10n)
    s.feedHead(25n)
    expect(s.fetcher.head).toBe(26n)
    // and the follow up reads run once per head for the providers a log
    // touched, at the newest sealed block known, the v2 provider had none
    await tick()
    expect(s.v3.afterProcessLog).toHaveBeenCalledWith(27n, new Set([POOL_A]))
    expect(s.v2.afterProcessLog).not.toHaveBeenCalled()
  })

  it('runs the follow up read once per followUpInterval heads, for the providers a log touched since their last run', async () => {
    const s = setup()
    const starting = s.fetcher.start(s.wsClient, {
      stallTimeout: 0,
      followUpInterval: 2,
    })
    await tick()
    s.feedHead(17n)
    await starting
    // the v2 provider is only asked by the per head read, once a log of its
    // pool applied
    ;(s.v2.afterProcessLog as any).mockClear()
    s.feedLog(sync(POOL_B, 20n, 18n))
    s.feedHead(18n)
    await tick()
    expect(s.v2.afterProcessLog).not.toHaveBeenCalled()
    s.feedHead(19n)
    await tick()
    expect(s.v2.afterProcessLog).toHaveBeenCalledTimes(1)
    expect(s.v2.afterProcessLog).toHaveBeenCalledWith(19n, new Set([POOL_B]))
    // no v2 log since: the next run leaves the v2 provider out
    s.feedHead(20n)
    await tick()
    s.feedHead(21n)
    await tick()
    expect(s.v2.afterProcessLog).toHaveBeenCalledTimes(1)
    s.feedLog(sync(POOL_B, 21n, 22n))
    s.feedHead(22n)
    await tick()
    s.feedHead(23n)
    await tick()
    expect(s.v2.afterProcessLog).toHaveBeenCalledTimes(2)
    expect(s.v2.afterProcessLog).toHaveBeenLastCalledWith(
      23n,
      new Set([POOL_B]),
    )
    // a Swap queues its tick words, they are read at the next run only
    ;(s.v3.afterProcessLog as any).mockClear()
    s.feedLog(swap(POOL_A, 5n * 2n ** 96n, 24n, undefined, 100))
    await tick()
    expect(s.v3.afterProcessLog).not.toHaveBeenCalled()
    s.feedHead(24n)
    await tick()
    expect(s.v3.afterProcessLog).not.toHaveBeenCalled()
    s.feedHead(25n)
    await tick()
    expect(s.v3.afterProcessLog).toHaveBeenCalledWith(25n, new Set([POOL_A]))
    // and the interval must be 1 or more
    const other = setup()
    await expect(
      other.fetcher.start(other.wsClient, { followUpInterval: 0 }),
    ).rejects.toThrow('followUpInterval')
  })

  it('reports a pool creation', async () => {
    const s = setup()
    const onPoolCreated = vi.fn()
    const starting = s.fetcher.start(s.wsClient, {
      stallTimeout: 0,
      onPoolCreated,
    })
    await tick()
    s.feedHead(17n)
    await starting
    // the pool was found missing before
    s.v3.nullPools.set(POOL_C, 1)
    s.feedLog(
      rawLog(
        s.v3.factory[ChainId.BASE]!,
        EVENTS.poolCreated,
        {
          token0: WETH.address,
          token1: USDC.address,
          fee: 500,
          tickSpacing: 10,
          pool: POOL_C,
        },
        18n,
      ),
    )
    await tick()
    expect(onPoolCreated).toHaveBeenCalledTimes(1)
    expect(s.v3.nullPools.has(POOL_C)).toBe(false)
  })
})

describe('RainDataFetcherStream drops', () => {
  it('holds every log on a drop, reopens after the delay, reads from the proven block and replays', async () => {
    const s = setup()
    await started(s, true)
    s.feedHead(20n)
    expect(s.fetcher.complete.get(POOL_A)).toBe(18n)
    const before = s.subs.length
    const epoch = s.fetcher.epoch
    s.subs[1]!.onError(new Error('socket closed'))
    expect(s.fetcher.drops).toBe(1)
    expect(s.fetcher.epoch).toBe(epoch + 1)
    expect(s.fetcher.open).toBe(false)
    expect(s.fetcher.holdingAll).toBe(true)
    // both subscriptions are dropped
    expect(s.unsubscribe).toHaveBeenCalledTimes(2)
    await tick()
    // reopened: a new heads and a new logs subscription
    expect(s.subs.length).toBe(before + 2)
    expect(s.fetcher.open).toBe(true)
    expect(s.fetcher.gaps).toEqual([{ pools: undefined, readyAt: 22n }])
    // missed while down, served by the read
    s.readable_(swap(POOL_A, 3n * 2n ** 96n, 19n))
    s.readable_(mint(POOL_A, 5n, 21n))
    // the new stream serves the pending block 23, held
    s.feedLog(mint(POOL_A, 4n, 23n), 'pendingLogs')
    expect(s.poolA.liquidity).toBe(1n)
    s.feedHead(21n)
    await tick()
    expect(s.getLogs).toHaveBeenCalledTimes(1)
    s.feedHead(22n)
    await tick()
    expect(s.getLogs).toHaveBeenCalledTimes(2)
    expect(s.getLogs.mock.calls[1]![0]).toMatchObject({
      fromBlock: 19n,
      toBlock: 22n,
    })
    // the missed logs landed in order (the swap sets the liquidity to 7,
    // the Mint adds 5), then the held pending Mint adds 4
    expect(s.poolA.liquidity).toBe(7n + 5n + 4n)
    expect(s.poolA.sqrtPriceX96).toBe(3n * 2n ** 96n)
    expect(s.poolA.blockNumber).toBe(23n)
    expect(s.fetcher.holdingAll).toBe(false)
    expect(s.fetcher.held).toEqual([])
    // an error of the dropped subscription is not another drop
    s.subs[1]!.onError(new Error('late'))
    expect(s.fetcher.drops).toBe(1)
  })

  it('takes a stalled heads stream as a drop', async () => {
    const s = setup()
    const starting = s.fetcher.start(s.wsClient, {
      resubscribeDelay: 1,
      stallTimeout: 5,
    })
    await tick()
    s.feedHead(17n)
    await starting
    expect(s.fetcher.drops).toBe(0)
    await new Promise((r) => setTimeout(r, 20))
    expect(s.fetcher.drops).toBeGreaterThanOrEqual(1)
    expect(s.fetcher.lastError).toMatchObject({ message: 'no head for 5 ms' })
    await s.fetcher.stop()
  })

  it('takes a reopen the node never answers as a drop as well', async () => {
    const s = setup()
    const starting = s.fetcher.start(s.wsClient, {
      resubscribeDelay: 1,
      stallTimeout: 5,
    })
    await tick()
    s.feedHead(17n)
    await starting
    // the reopen's heads subscribe hangs
    s.subscribe.mockImplementationOnce(
      (args: Sub) =>
        new Promise(() => {
          s.subs.push(args)
        }),
    )
    const calls = s.subscribe.mock.calls.length
    s.subs[1]!.onError(new Error('socket closed'))
    await new Promise((r) => setTimeout(r, 30))
    // dropped again by the stall, and tried again after it
    expect(s.fetcher.drops).toBeGreaterThanOrEqual(2)
    expect(s.subscribe.mock.calls.length).toBeGreaterThan(calls + 1)
    await s.fetcher.stop()
  })

  it('measures a reopen against the read client head when the socket head is behind', async () => {
    const s = setup()
    await started(s)
    // the socket died long ago at head 17, the chain is at 40 by the reopen
    s.chain.head = 40n
    s.subs[1]!.onError(new Error('socket closed'))
    await tick()
    expect(s.fetcher.openedAt).toBe(40n)
    expect(s.fetcher.gaps).toEqual([{ pools: undefined, readyAt: 42n }])
  })

  it('tries the reopen again when it fails', async () => {
    const s = setup()
    await started(s)
    const count = s.subscribe.mock.calls.length
    s.subscribe.mockRejectedValueOnce(new Error('still down'))
    s.subs[1]!.onError(new Error('socket closed'))
    await tick()
    expect(s.fetcher.drops).toBe(2)
    await tick()
    // the second try opened both
    expect(s.subscribe.mock.calls.length).toBe(count + 3)
    expect(s.fetcher.open).toBe(true)
  })

  it('never waits for an unsubscribe, the node may not answer one', async () => {
    const s = setup()
    s.unsubscribe.mockImplementation(() => new Promise(() => {}))
    await started(s)
    s.fetcher.unsubscribeTimeout = 5
    // a fetch with a new pool replaces the subscription, the old one
    // never confirms its end, the gap still gets its head
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_C]), readyAt: 19n }])
    // and a stop returns within its bound
    const begun = Date.now()
    await s.fetcher.stop()
    expect(Date.now() - begun).toBeLessThan(1000)
    expect(s.fetcher.wsClient).toBeUndefined()
  })
})

describe('RainDataFetcherStream.fetchPoolsForToken', () => {
  it('leaves the follow up of a gap over some pools to the next head, the other pools kept streaming past the read', async () => {
    const s = setup()
    await started(s)
    ;(s.v3.afterProcessLog as any).mockClear()
    ;(s.v2.afterProcessLog as any).mockClear()
    // C, a v3 pool, is fetched at 17 and read once the head passed the margin
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    s.feedHead(19n)
    await tick()
    expect(s.fetcher.gaps).toEqual([])
    // the read ran no follow up pinned at its end
    expect(s.v3.afterProcessLog).not.toHaveBeenCalled()
    expect(s.v2.afterProcessLog).not.toHaveBeenCalled()
    // the next head reads C's provider, at the head
    s.feedHead(20n)
    await tick()
    expect(s.v3.afterProcessLog).toHaveBeenCalledTimes(1)
    expect(s.v3.afterProcessLog).toHaveBeenCalledWith(20n, new Set([POOL_C]))
    expect(s.v2.afterProcessLog).not.toHaveBeenCalled()
  })

  it('parks the queued words of a held pool during a follow up, they are read once its hold lifts', async () => {
    const s = setup()
    await started(s)
    const seen: string[][] = []
    s.v3.afterProcessLog = vi.fn(async () => {
      seen.push(s.v3.newTicksQueue.map(([pool]) => pool.address))
    })
    // C is fetched at 17 with the head at 1100, its read brings a Swap that
    // queues C's words
    s.feedHead(1100n)
    await tick()
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    expect(s.fetcher.gaps[0]!.readyAt).toBe(1102n)
    s.readable_(swap(POOL_C, 5n * 2n ** 96n, 18n, undefined, 100))
    // the second slice fails: the read stops short of 1102, C stays held
    s.failSlice(1018n)
    s.feedHead(1102n)
    await tick()
    expect(s.fetcher.complete.get(POOL_C)).toBe(1017n)
    expect(s.fetcher.holding).toEqual(new Set([POOL_C]))
    expect(s.v3.newTicksQueue.map(([pool]) => pool.address)).toEqual([POOL_C])
    // the head's follow up runs for the provider the read's Swap touched, C's
    // words wait, the retry read lands after it and lifts the hold
    s.feedHead(1103n)
    await tick()
    expect(seen).toEqual([[]])
    expect(s.fetcher.holding.size).toBe(0)
    expect(s.v3.newTicksQueue.map(([pool]) => pool.address)).toEqual([POOL_C])
    // the next head reads them
    s.feedHead(1104n)
    await tick()
    expect(seen).toEqual([[], [POOL_C]])
  })

  it('covers the fetched pools: subscription replaced, logs held, gap read from the fetch block, replay', async () => {
    const s = setup()
    await started(s)
    s.writesC()
    const subsBefore = s.subs.length
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    expect(parentFetch).toHaveBeenCalledTimes(1)
    expect(parentFetch.mock.calls[0]![3]).toMatchObject({ blockNumber: 17n })
    const poolC = s.v3.pools.get(POOL_C)!
    // admitted at once, complete through the fetch block, held
    expect(s.fetcher.admitted.get(POOL_C)).toBe(poolC)
    expect(s.fetcher.complete.get(POOL_C)).toBe(17n)
    expect(s.fetcher.holding).toEqual(new Set([POOL_C]))
    expect(s.fetcher.gaps).toEqual([
      { pools: new Set([POOL_C]), readyAt: undefined },
    ])
    await tick()
    // the new subscription covers C, the old one was dropped after, and
    // the read waits for the margin past the head the subscription was up at
    expect(s.subs.length).toBe(subsBefore + 1)
    const filter = s.subs[subsBefore]!.params[1]
    expect(filter.address).toEqual([
      ...s.fetcher.factories,
      POOL_A,
      POOL_C,
      POOL_B,
    ])
    expect(s.unsubscribe).toHaveBeenCalledTimes(1)
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_C]), readyAt: 19n }])
    // C's logs are held, A's flow
    s.feedLog(s.readable_(swap(POOL_C, 4n * 2n ** 96n, 18n)))
    s.feedLog(swap(POOL_A, 4n * 2n ** 96n, 18n))
    expect(poolC.sqrtPriceX96).toBe(2n * 2n ** 96n)
    expect(s.poolA.sqrtPriceX96).toBe(4n * 2n ** 96n)
    // a head does not move a pool under a gap read
    s.feedHead(18n)
    expect(s.fetcher.complete.get(POOL_C)).toBe(17n)
    // missed between the fetch and the subscription, served by the read
    s.readable_(mint(POOL_C, 5n, 18n))
    s.readable_(swap(POOL_C, 6n * 2n ** 96n, 19n))
    s.feedHead(19n)
    await tick()
    // the read covers C alone, from the fetch block exclusive
    expect(s.getLogs).toHaveBeenCalledTimes(2)
    expect(s.getLogs.mock.calls[1]![0]).toMatchObject({
      fromBlock: 18n,
      toBlock: 19n,
      address: [...s.fetcher.factories, POOL_C],
    })
    // the swap of block 19 set the liquidity after the Mint of 18 added 5
    expect(poolC.liquidity).toBe(7n)
    expect(poolC.sqrtPriceX96).toBe(6n * 2n ** 96n)
    expect(poolC.blockNumber).toBe(19n)
    expect(s.fetcher.holding.size).toBe(0)
    expect(s.fetcher.gaps).toEqual([])
    // from here its logs flow
    s.feedLog(swap(POOL_C, 8n * 2n ** 96n, 20n))
    expect(poolC.sqrtPriceX96).toBe(8n * 2n ** 96n)
  })

  it('gives the gap its head only once the subscription covers the pool', async () => {
    const s = setup()
    await started(s)
    s.writesC()
    // the new subscription takes a while, a head comes in meanwhile
    const release = s.slowSubscribe()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    expect(s.fetcher.holding).toEqual(new Set([POOL_C]))
    expect(s.fetcher.gaps).toEqual([
      { pools: new Set([POOL_C]), readyAt: undefined },
    ])
    s.feedHead(19n)
    await tick()
    expect(s.getLogs).toHaveBeenCalledTimes(1)
    release()
    await tick()
    // the margin counts from the head the subscription was up at
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_C]), readyAt: 21n }])
    expect(s.getLogs).toHaveBeenCalledTimes(1)
  })

  it('takes the fetched pool its own block as complete, a fetch alongside may have written it', async () => {
    const s = setup()
    await started(s)
    // the pool object carries block 18 while this fetch asked for 17
    s.writesC(1n)
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    expect(s.fetcher.complete.get(POOL_C)).toBe(18n)
    s.readable_(swap(POOL_C, 6n * 2n ** 96n, 18n))
    s.readable_(swap(POOL_C, 7n * 2n ** 96n, 19n))
    s.feedHead(19n)
    await tick()
    // the read starts above the pool's own block, block 18 is in its state
    expect(s.getLogs.mock.calls[1]![0]).toMatchObject({
      fromBlock: 19n,
      toBlock: 19n,
    })
    expect(s.v3.pools.get(POOL_C)!.sqrtPriceX96).toBe(7n * 2n ** 96n)
  })

  it('admits a pool a fetch alongside admitted first only once', async () => {
    const s = setup()
    await started(s)
    // the slow fetch writes C at once and goes on with other providers
    const releaseSlow = s.writesC(0n, true)
    const slow = s.fetcher.fetchPoolsForToken(WETH, DAI, undefined, {
      blockNumber: 17n,
    })
    await tick()
    const poolC = s.v3.pools.get(POOL_C)!
    expect(s.fetcher.admitted.has(POOL_C)).toBe(false)
    // a fast fetch of a pair sharing C ends first and admits it
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    expect(s.fetcher.admitted.get(POOL_C)).toBe(poolC)
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_C]), readyAt: 19n }])
    s.feedHead(19n)
    await tick()
    expect(s.fetcher.holding.size).toBe(0)
    // C flows: a Mint of the pending block 20 lands
    s.feedLog(mint(POOL_C, 5n, 20n))
    expect(poolC.liquidity).toBe(6n)
    expect(poolC.blockNumber).toBe(20n)
    // the slow fetch ends: C is admitted already, nothing happens to it
    releaseSlow()
    await slow
    await tick()
    expect(s.fetcher.gaps).toEqual([])
    expect(s.fetcher.holding.size).toBe(0)
    expect(s.fetcher.complete.get(POOL_C)).toBe(19n)
    // and the rest of block 20 lands as well
    s.feedLog(mint(POOL_C, 4n, 20n))
    expect(poolC.liquidity).toBe(10n)
  })

  it('neither proves nor serves a pool a running fetch wrote until the fetch admits it', async () => {
    const s = setup()
    await started(s)
    const release = s.writesC(0n, true)
    const fetching = s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    const poolC = s.v3.pools.get(POOL_C)!
    // heads pass the margin: C is not proven, it is not covered yet
    s.feedHead(19n)
    s.feedHead(20n)
    s.feedHead(21n)
    expect(poolC.blockNumber).toBe(17n)
    expect(s.fetcher.complete.has(POOL_C)).toBe(false)
    expect(s.poolA.blockNumber).toBe(19n)
    // a log for it is held, not applied to the unadmitted object
    s.feedLog(s.readable_(mint(POOL_C, 5n, 21n)))
    expect(poolC.liquidity).toBe(1n)
    expect(s.fetcher.held.length).toBe(1)
    // the fetch ends: admitted at its block, its read waits for 23
    release()
    await fetching
    await tick()
    expect(s.fetcher.complete.get(POOL_C)).toBe(17n)
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_C]), readyAt: 23n }])
    s.readable_(mint(POOL_C, 100n, 18n))
    s.feedHead(23n)
    await tick()
    expect(s.getLogs.mock.calls[1]![0]).toMatchObject({
      fromBlock: 18n,
      toBlock: 23n,
    })
    // the Mint of 18 and the one of 21 (held, read too, applied once)
    expect(poolC.liquidity).toBe(106n)
    expect(s.fetcher.held).toEqual([])
    expect(s.fetcher.holding.size).toBe(0)
  })

  it('leaves a replaced pool object to its own fetch, an earlier gap does not read it', async () => {
    const s = setup()
    await started(s)
    // fetch X admits C (object 1) at 17
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    const first = s.v3.pools.get(POOL_C)!
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_C]), readyAt: 19n }])
    s.feedHead(18n)
    // fetch Y reads C again at 19 (object 2) and goes on
    const release = s.writesC(0n, true)
    const slow = s.fetcher.fetchPoolsForToken(WETH, DAI, undefined, {
      blockNumber: 19n,
    })
    await tick()
    const second = s.v3.pools.get(POOL_C)!
    expect(second).not.toBe(first)
    // the Mint of 19 is in object 2's state already
    s.readable_(mint(POOL_C, 100n, 19n))
    s.feedHead(19n)
    await tick()
    // X's gap ran out of pools to read: no read, C's hold lifted, and
    // object 2 is still not admitted so its logs are held
    expect(s.getLogs).toHaveBeenCalledTimes(1)
    expect(s.fetcher.gaps).toEqual([])
    expect(s.fetcher.holding.size).toBe(0)
    expect(second.liquidity).toBe(1n)
    s.feedLog(s.readable_(mint(POOL_C, 5n, 20n)))
    expect(second.liquidity).toBe(1n)
    expect(s.fetcher.held.length).toBe(1)
    // Y ends: object 2 admitted at 19, its read starts above 19
    release()
    await slow
    await tick()
    expect(s.fetcher.admitted.get(POOL_C)).toBe(second)
    expect(s.fetcher.complete.get(POOL_C)).toBe(19n)
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_C]), readyAt: 21n }])
    s.feedHead(21n)
    await tick()
    expect(s.getLogs.mock.calls[1]![0]).toMatchObject({
      fromBlock: 20n,
      toBlock: 21n,
    })
    // the Mint of 19 was not applied twice, the one of 20 (read, then
    // replayed from the hold) landed once
    expect(second.liquidity).toBe(6n)
  })

  it('leaves a pool a fetch replaced during the read alone: no logs applied to it, its hold stays', async () => {
    const s = setup()
    await started(s)
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    const first = s.v3.pools.get(POOL_C)!
    // the read serves C's Mint of 19, which is in object 2's state as well
    s.readable_(mint(POOL_C, 100n, 19n))
    const releaseReads = s.holdReads()
    s.feedHead(19n)
    await tick()
    expect(s.getLogs).toHaveBeenCalledTimes(2)
    // another fetch reads C again at 19 while the read is in flight
    const releaseFetch = s.writesC(0n, true)
    const slow = s.fetcher.fetchPoolsForToken(WETH, DAI, undefined, {
      blockNumber: 19n,
    })
    await tick()
    const second = s.v3.pools.get(POOL_C)!
    expect(second).not.toBe(first)
    releaseReads()
    await tick()
    // the read is over: object 2 untouched, C's bookkeeping and hold as well
    expect(second.liquidity).toBe(1n)
    expect(s.fetcher.complete.get(POOL_C)).toBe(17n)
    expect(s.fetcher.holding).toEqual(new Set([POOL_C]))
    expect(s.fetcher.gaps).toEqual([])
    // the fetch ends: object 2 admitted at 19, its read starts above 19
    releaseFetch()
    await slow
    await tick()
    expect(s.fetcher.admitted.get(POOL_C)).toBe(second)
    expect(s.fetcher.complete.get(POOL_C)).toBe(19n)
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_C]), readyAt: 21n }])
  })

  it('covers a pool fetched while the stream goes up', async () => {
    const s = setup()
    s.writesC()
    // the logs subscription takes a while, the fetch lands meanwhile
    s.subscribe.mockImplementationOnce(async (args: Sub) => {
      s.subs.push(args)
      return { subscriptionId: '0x1', unsubscribe: s.unsubscribe }
    })
    const release = s.slowSubscribe()
    const starting = s.fetcher.start(s.wsClient, { stallTimeout: 0 })
    await tick()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 15n,
    })
    // not open yet: admitted, nothing of its own, the open takes it
    expect(s.fetcher.complete.get(POOL_C)).toBe(15n)
    expect(s.fetcher.gaps).toEqual([])
    expect(s.fetcher.holding.size).toBe(0)
    release()
    await tick()
    // the first logs subscription missed C, a second one covers it
    expect(s.subs.length).toBe(3)
    expect(s.subs[1]!.params[1].address).not.toContain(POOL_C)
    expect(s.subs[2]!.params[1].address).toContain(POOL_C)
    expect(s.fetcher.gaps).toEqual([{ pools: undefined, readyAt: 17n }])
    s.readable_(swap(POOL_C, 6n * 2n ** 96n, 16n))
    s.feedHead(17n)
    await starting
    // the read of the whole ran from C's fetch block as well
    expect(s.v3.pools.get(POOL_C)!.sqrtPriceX96).toBe(6n * 2n ** 96n)
    expect(s.fetcher.complete.get(POOL_C)).toBe(17n)
  })

  it('keeps the gap of a pool fetched during a reopen until the stream covers it', async () => {
    const s = setup()
    await started(s, true)
    s.feedHead(20n)
    s.subs[1]!.onError(new Error('socket closed'))
    await tick()
    // reopened at head 20, the read of the whole waits for 22
    expect(s.fetcher.open).toBe(true)
    expect(s.fetcher.gaps).toEqual([{ pools: undefined, readyAt: 22n }])
    s.writesC()
    s.feedHead(21n)
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 20n,
    })
    await tick()
    // held by itself as well, its own read waits for 23
    expect(s.fetcher.holding).toEqual(new Set([POOL_C]))
    expect(s.fetcher.gaps).toEqual([
      { pools: undefined, readyAt: 22n },
      { pools: new Set([POOL_C]), readyAt: 23n },
    ])
    // the stream serves a pending log of C ahead of both reads, held
    s.feedLog(swap(POOL_C, 9n * 2n ** 96n, 24n), 'pendingLogs')
    s.readable_(swap(POOL_C, 6n * 2n ** 96n, 21n))
    s.feedHead(22n)
    await tick()
    // the read of the whole took C from its fetch block, C stays held
    expect(s.getLogs.mock.calls[1]![0]).toMatchObject({
      fromBlock: 19n,
      toBlock: 22n,
    })
    expect(s.v3.pools.get(POOL_C)!.sqrtPriceX96).toBe(6n * 2n ** 96n)
    expect(s.fetcher.holdingAll).toBe(false)
    expect(s.fetcher.holding).toEqual(new Set([POOL_C]))
    expect(s.fetcher.held.length).toBe(1)
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_C]), readyAt: 23n }])
    s.feedHead(23n)
    await tick()
    // its own read runs from where the whole left it, then the held log lands
    expect(s.getLogs.mock.calls[2]![0]).toMatchObject({
      fromBlock: 23n,
      toBlock: 23n,
      address: [...s.fetcher.factories, POOL_C],
    })
    expect(s.v3.pools.get(POOL_C)!.sqrtPriceX96).toBe(9n * 2n ** 96n)
    expect(s.fetcher.holding.size).toBe(0)
    expect(s.fetcher.held).toEqual([])
    expect(s.fetcher.gaps).toEqual([])
  })

  it('does nothing more when the fetch read no pool', async () => {
    const s = setup()
    await started(s)
    const subsBefore = s.subs.length
    await s.fetcher.fetchPoolsForToken(WETH, USDC)
    await tick()
    expect(parentFetch).toHaveBeenCalledTimes(1)
    expect(s.subs.length).toBe(subsBefore)
    expect(s.fetcher.gaps).toEqual([])
    expect(s.fetcher.holding.size).toBe(0)
  })

  it('closes a gap once the read client reached it, while a new gap comes due at each head', async () => {
    const s = setup()
    await started(s)
    // the read client sits one block behind the socket
    s.chain.lag = 1n
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_C]), readyAt: 19n }])
    // a fetch before each head brings a new pool, its gap is due 2 heads on
    for (let head = 18n; head <= 24n; head++) {
      const address = `0x${head.toString(16).padStart(40, 'e')}` as Address
      parentImpls.push((_t0, _t1, _e, options) => {
        s.v3.pools.set(address, v3Pool(address, options.blockNumber))
      })
      await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
        blockNumber: head - 1n,
      })
      await tick()
      s.feedHead(head)
      await tick()
    }
    // C is due at 19, the read client is at 19 from head 20 on
    expect(s.fetcher.gaps.some((gap) => gap.pools?.has(POOL_C))).toBe(false)
    expect(s.fetcher.holding.has(POOL_C)).toBe(false)
    // only the gaps the read client has not reached yet stay
    expect(s.fetcher.gaps.every((gap) => gap.readyAt! > 23n)).toBe(true)
  })

  it('is the parent fetch before start', async () => {
    const s = setup()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 5n,
    })
    expect(parentFetch).toHaveBeenCalledTimes(1)
    expect(s.fetcher.gaps).toEqual([])
    expect(s.subs.length).toBe(0)
  })

  it('a drop gap covers a pool fetched meanwhile', async () => {
    const s = setup()
    await started(s)
    s.subs[1]!.onError(new Error('socket closed'))
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    // admitted, held with the rest, no subscription of its own while down
    expect(s.fetcher.admitted.has(POOL_C)).toBe(true)
    expect(s.fetcher.holdingAll).toBe(true)
    expect(s.fetcher.holding.size).toBe(0)
    await tick()
    // the reopen covers it
    const filter = s.subs[s.subs.length - 1]!.params[1]
    expect(filter.address).toContain(POOL_C)
    expect(s.fetcher.gaps.length).toBe(1)
    expect(s.fetcher.gaps[0]!.pools).toBeUndefined()
  })

  it('keeps the newer logs subscription when an older one comes up last', async () => {
    const s = setup()
    await started(s)
    // a fetch's replacement hangs, then a drop and a reopen put a newer one up
    const release = s.slowSubscribe()
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    s.subs[1]!.onError(new Error('socket closed'))
    await tick()
    const newest = s.fetcher.subscription
    expect(newest).toBeDefined()
    const unsubscribes = s.unsubscribe.mock.calls.length
    release()
    await tick()
    // the late one is dropped, the newest stays with every pool
    expect(s.fetcher.subscription).toBe(newest)
    expect(s.unsubscribe.mock.calls.length).toBe(unsubscribes + 1)
    expect(s.fetcher.subscribed).toEqual(new Set([POOL_A, POOL_C, POOL_B]))
  })
})

describe('RainDataFetcherStream fee module logs', () => {
  const feeLog = (pool: Address, fee: number, block: bigint) =>
    rawLog(FEE_MODULE, EVENTS.customFeeSet, { pool, fee }, block)

  it('holds a fee module log with the pool it names until that pool is read, and reports the fee change', async () => {
    const s = setup({ slipstream: true })
    const onPoolsChange = vi.fn()
    const starting = s.fetcher.start(s.wsClient, {
      stallTimeout: 0,
      onPoolsChange,
    })
    await tick()
    s.feedHead(17n)
    await starting
    // the fee module is subscribed with the factories and the pools
    expect(s.subs[1]!.params[1].address).toEqual([
      ...s.fetcher.factories,
      FEE_MODULE,
      POOL_A,
      POOL_B,
    ])
    s.writesD()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    const poolD = s.slip.pools.get(POOL_D) as SlipstreamPool
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_D]), readyAt: 19n }])
    // the stream serves D's fee change of block 18 before the read, and a
    // scaling factor change of block 18 as well: held with D, not applied
    s.feedLog(s.readable_(feeLog(POOL_D, 700, 18n)))
    s.feedLog(
      s.readable_(
        rawLog(
          FEE_MODULE,
          EVENTS.scalingFactorSet,
          { pool: POOL_D, scalingFactor: 0n },
          18n,
        ),
      ),
    )
    expect(s.fetcher.held.length).toBe(2)
    expect(poolD.blockNumber).toBe(17n)
    expect(poolD.fee).toBe(500)
    // the read serves D's Mint of 18 as well, all land in order, once
    s.readable_(mint(POOL_D, 100n, 18n))
    onPoolsChange.mockClear()
    s.feedHead(19n)
    await waitFor(() => onPoolsChange.mock.calls.length > 0)
    expect(poolD.liquidity).toBe(101n)
    expect(poolD.fee).toBe(700)
    expect(poolD.feeType).toBe(FeeType.Dynamic)
    expect(poolD.blockNumber).toBe(19n)
    expect(s.fetcher.held).toEqual([])
    expect(onPoolsChange).toHaveBeenCalledWith([POOL_D], expect.anything())
  })

  it('leaves a fee module log of a pool outside the read to that pool', async () => {
    const s = setup({ slipstream: true })
    await started(s)
    // C is admitted at 17 and read at 19, D at 18 and read at 20
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    s.feedHead(18n)
    s.writesD()
    await s.fetcher.fetchPoolsForToken(WETH, DAI, undefined, {
      blockNumber: 18n,
    })
    await tick()
    expect(s.fetcher.gaps).toEqual([
      { pools: new Set([POOL_C]), readyAt: 19n },
      { pools: new Set([POOL_D]), readyAt: 20n },
    ])
    const poolD = s.slip.pools.get(POOL_D) as SlipstreamPool
    // D's fee change of 19 is in the range of C's read
    s.readable_(feeLog(POOL_D, 700, 19n))
    s.feedHead(19n)
    await tick()
    // C's read left it alone, D is still at its fetch block
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_D]), readyAt: 20n }])
    expect(poolD.blockNumber).toBe(18n)
    expect(poolD.fee).toBe(500)
    s.feedHead(20n)
    await tick()
    // D's own read applied it
    expect(poolD.fee).toBe(700)
    expect(poolD.blockNumber).toBe(20n)
    expect(s.fetcher.gaps).toEqual([])
  })

  it('never holds a module wide fee module log, the stream and the reads apply it', async () => {
    const s = setup({ slipstream: true })
    await started(s)
    s.writesD()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    const poolD = s.slip.pools.get(POOL_D) as SlipstreamPool
    expect(s.fetcher.holding).toEqual(new Set([POOL_D]))
    // a default fee cap below D's base fee, from the stream while D is held:
    // applied at once, D's fee is capped, D's block is not moved
    s.feedLog(
      rawLog(FEE_MODULE, EVENTS.defaultFeeCapSet, { defaultFeeCap: 100n }, 18n),
    )
    expect(s.fetcher.held).toEqual([])
    expect(poolD.fee).toBe(100)
    expect(poolD.blockNumber).toBe(17n)
    // another one only in the read, in D's gap range: applied by the read
    s.readable_(
      rawLog(FEE_MODULE, EVENTS.defaultFeeCapSet, { defaultFeeCap: 50n }, 19n),
    )
    s.feedHead(19n)
    await tick()
    expect(poolD.fee).toBe(50)
    expect(poolD.blockNumber).toBe(19n)
    expect(s.fetcher.gaps).toEqual([])
    // and a fee module log naming a pool no provider holds is applied as
    // module wide, nothing is held for it
    s.feedLog(feeLog(POOL_C, 700, 20n))
    expect(s.fetcher.held).toEqual([])
  })

  it('does not let a read set a module wide setting back to an older value', async () => {
    const s = setup({ slipstream: true })
    await started(s, true)
    // D is admitted at 17, its subscription takes long, so its read waits
    const release = s.slowSubscribe()
    s.writesD()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    const poolD = s.slip.pools.get(POOL_D) as SlipstreamPool
    // a default fee cap of 100 at block 18, the read serves it too
    s.feedLog(
      s.readable_(
        rawLog(
          FEE_MODULE,
          EVENTS.defaultFeeCapSet,
          { defaultFeeCap: 100n },
          18n,
        ),
      ),
      'pendingLogs',
    )
    expect(poolD.fee).toBe(100)
    // heads pass, the id of that log is pruned below the proven block
    for (const head of [18n, 19n, 20n, 21n, 22n]) s.feedHead(head)
    expect(s.fetcher.applied.has(FEE_MODULE)).toBe(false)
    release()
    await tick()
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_D]), readyAt: 24n }])
    // a newer default fee cap of 50 in the pending block 25
    s.feedLog(
      rawLog(FEE_MODULE, EVENTS.defaultFeeCapSet, { defaultFeeCap: 50n }, 25n),
      'pendingLogs',
    )
    expect(poolD.fee).toBe(50)
    // D's read covers block 18 and brings the older cap back: not applied
    s.feedHead(23n)
    s.feedHead(24n)
    await tick()
    expect(s.getLogs.mock.calls[1]![0]).toMatchObject({
      fromBlock: 18n,
      toBlock: 24n,
    })
    expect(poolD.fee).toBe(50)
    expect(poolD.blockNumber).toBe(24n)
    expect(s.fetcher.gaps).toEqual([])
  })

  it('applies a fee module log of a pool served before the pool was cached, once the pool is read', async () => {
    const s = setup({ slipstream: true })
    await started(s)
    // D is not cached: the module's fee change for it streams by, nothing is
    // held and nothing is taken as module wide
    s.feedLog(s.readable_(feeLog(POOL_D, 700, 18n)))
    expect(s.fetcher.held).toEqual([])
    expect(s.fetcher.moduleApplied.size).toBe(0)
    // D is fetched at 17, the settings read there carry the old fee
    s.writesD()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    const poolD = s.slip.pools.get(POOL_D) as SlipstreamPool
    expect(poolD.fee).toBe(500)
    s.feedHead(19n)
    await tick()
    // the read of (17, 19] brings the fee change, it is D's and applies
    expect(poolD.fee).toBe(700)
    expect(poolD.blockNumber).toBe(19n)
    expect(s.fetcher.gaps).toEqual([])
  })

  const moduleChange = (s: ReturnType<typeof setup>, block: bigint) =>
    rawLog(
      s.slip.factory[ChainId.BASE]!,
      EVENTS.swapFeeModuleChanged,
      { oldFeeModule: FEE_MODULE, newFeeModule: NEW_MODULE },
      block,
    )

  it('covers a changed fee module: the slipstream pools are read with the new module from their blocks on', async () => {
    const s = setup({ slipstream: true })
    await started(s)
    s.writesD()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    s.feedHead(19n)
    await tick()
    const poolD = s.slip.pools.get(POOL_D) as SlipstreamPool
    expect(s.fetcher.holding.size).toBe(0)
    // the factory moves the module at block 20, the new subscription takes a while
    const release = s.slowSubscribe()
    s.feedLog(moduleChange(s, 20n))
    await tick()
    expect(s.slip.swapFeeModule[ChainId.BASE]!.toLowerCase()).toBe(NEW_MODULE)
    // D is held, its gap waits for the new subscription
    expect(s.fetcher.holding).toEqual(new Set([POOL_D]))
    expect(s.fetcher.gaps).toEqual([
      { pools: new Set([POOL_D]), readyAt: undefined },
    ])
    // the new module sets a default fee cap at 21, in no subscription yet
    s.readable_(
      rawLog(NEW_MODULE, EVENTS.defaultFeeCapSet, { defaultFeeCap: 50n }, 21n),
    )
    s.feedHead(20n)
    s.feedHead(21n)
    expect(poolD.fee).toBe(500)
    release()
    await tick()
    expect(s.fetcher.gaps).toEqual([{ pools: new Set([POOL_D]), readyAt: 23n }])
    const filter = s.subs[s.subs.length - 1]!.params[1].address
    expect(filter).toContain(NEW_MODULE)
    expect(filter).not.toContain(FEE_MODULE)
    s.feedHead(22n)
    s.feedHead(23n)
    await tick()
    // the read from D's block asked the new module and brought its log
    expect(s.getLogs.mock.calls[2]![0].address).toContain(NEW_MODULE)
    expect(poolD.fee).toBe(50)
    expect(s.fetcher.gaps).toEqual([])
    expect(s.fetcher.holding.size).toBe(0)
  })

  it('takes a failing subscribe for a changed fee module as a drop, the reopen covers it', async () => {
    const s = setup({ slipstream: true })
    await started(s)
    s.subscribe.mockRejectedValueOnce(new Error('busy'))
    s.feedLog(moduleChange(s, 18n))
    await waitFor(() => s.fetcher.drops >= 1)
    expect(s.fetcher.drops).toBe(1)
    await waitFor(() => s.fetcher.open)
    expect(s.subs[s.subs.length - 1]!.params[1].address).toContain(NEW_MODULE)
  })

  it('leaves the fee reset of a module change to a round at or past the change block', async () => {
    const s = setup({ slipstream: true })
    // the provider's own follow up read, its rpc reads stubbed
    delete (s.slip as any).afterProcessLog
    const init = vi.fn(async () => true)
    ;(s.slip as any).initFeeModule = init
    ;(s.slip as any).readFeeConfigs = vi.fn(async (pools: any[]) =>
      pools.map(() => ({ ...DEFAULT_FEE_CONFIG, baseFee: 500 })),
    )
    ;(s.slip as any).readPoolFees = vi.fn(async () => [])
    await started(s)
    // C's read is in flight at head 19 when the module changes at 20
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    const releaseReads = s.holdReads()
    s.feedHead(19n)
    await tick()
    s.feedLog(moduleChange(s, 20n))
    await tick()
    expect(s.slip.shouldResetFees).toBe(true)
    expect(s.slip.resetFeesFrom).toBe(20n)
    releaseReads()
    await tick()
    // the read's round at 19 left the reset alone
    expect(init).not.toHaveBeenCalled()
    expect(s.slip.shouldResetFees).toBe(true)
    s.feedHead(20n)
    await waitFor(() => init.mock.calls.length > 0)
    // the head's round at 20 ran it
    expect(init).toHaveBeenCalledWith(20n)
    expect(s.slip.shouldResetFees).toBe(false)
  })

  it('drops the fees of an older volatile round that lands after a newer one', async () => {
    const s = setup({ slipstream: true })
    delete (s.slip as any).afterProcessLog
    ;(s.slip as any).initFeeModule = vi.fn(async () => true)
    ;(s.slip as any).readFeeConfigs = vi.fn(async () => [])
    const rounds: { block: bigint; resolve: (fees: number[]) => void }[] = []
    // a round with volatile pools waits until the test lands it
    ;(s.slip as any).readPoolFees = vi.fn((pools: any[], block: bigint) =>
      pools.length
        ? new Promise((resolve) => rounds.push({ block, resolve }))
        : Promise.resolve([]),
    )
    await started(s)
    s.writesD()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    const poolD = s.slip.pools.get(POOL_D) as SlipstreamPool
    // a scaling factor makes D volatile, its fee comes from the rounds
    poolD.feeConfig = { ...poolD.feeConfig, scalingFactor: 5n }
    await tick()
    // a module wide log is never held, it makes the slipstream provider one
    // the next head's round asks; D's own read brings no round, its words
    // and fees are the next head's
    const moduleWide = (block: bigint) =>
      rawLog(
        FEE_MODULE,
        EVENTS.defaultFeeCapSet,
        { defaultFeeCap: 1_000_000n },
        block,
      )
    s.feedLog(moduleWide(19n))
    s.feedHead(19n)
    await tick()
    s.feedLog(moduleWide(20n))
    s.feedHead(20n)
    await tick()
    // the head rounds at 19 and 20
    expect(rounds.map((r) => r.block).sort()).toEqual([19n, 20n])
    const newest = rounds.find((r) => r.block === 20n)!
    newest.resolve([700])
    await tick()
    expect(poolD.fee).toBe(700)
    // the older rounds land now: dropped
    rounds.filter((r) => r.block === 19n).forEach((r) => r.resolve([600]))
    await tick()
    expect(poolD.fee).toBe(700)
    expect(s.slip.feeRoundBlock).toBe(20n)
    expect(s.slip.feeRoundBlocks.get(POOL_D)).toBe(20n)
  })

  it('keeps a pool at the fee of the newest round that covered it, a module wide log widens the round to every pool', async () => {
    const s = setup({ slipstream: true })
    delete (s.slip as any).afterProcessLog
    ;(s.slip as any).initFeeModule = vi.fn(async () => true)
    ;(s.slip as any).readFeeConfigs = vi.fn(async () => [])
    const rounds: {
      block: bigint
      pools: string[]
      resolve: (fees: number[]) => void
    }[] = []
    ;(s.slip as any).readPoolFees = vi.fn((pools: any[], block: bigint) =>
      pools.length
        ? new Promise((resolve) =>
            rounds.push({ block, pools: pools.map((p) => p.address), resolve }),
          )
        : Promise.resolve([]),
    )
    await started(s)
    s.writesD()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    const poolD = s.slip.pools.get(POOL_D) as SlipstreamPool
    poolD.feeConfig = { ...poolD.feeConfig, scalingFactor: 5n }
    await tick()
    s.feedHead(19n)
    await tick()
    // D's read lands, D is marked: the head 20 round is for D alone
    s.feedHead(20n)
    await tick()
    expect(rounds.map((r) => [r.block, r.pools])).toEqual([[20n, [POOL_D]]])
    // a module wide log widens the next round to every pool
    s.feedLog(
      rawLog(
        FEE_MODULE,
        EVENTS.defaultFeeCapSet,
        { defaultFeeCap: 1_000_000n },
        21n,
      ),
    )
    s.feedHead(21n)
    await tick()
    expect(rounds.map((r) => r.block)).toEqual([20n, 21n])
    // the newer round lands first, then the older one for D: D keeps the newer fee
    rounds[1]!.resolve([700])
    await tick()
    expect(poolD.fee).toBe(700)
    rounds[0]!.resolve([600])
    await tick()
    expect(poolD.fee).toBe(700)
    expect(s.slip.feeRoundBlocks.get(POOL_D)).toBe(21n)
  })

  it('keeps the ids of a held pool, so the cover read does not apply its logs again', async () => {
    const s = setup({ slipstream: true })
    await started(s)
    s.writesD()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    s.feedHead(19n)
    await tick()
    const poolD = s.slip.pools.get(POOL_D) as SlipstreamPool
    s.feedHead(20n)
    s.feedHead(21n)
    expect(s.fetcher.complete.get(POOL_D)).toBe(19n)
    // a Mint of block 21 streams in and applies
    s.feedLog(s.readable_(mint(POOL_D, 5n, 21n)))
    expect(poolD.liquidity).toBe(6n)
    // the module moves at 21, the cover holds D, its subscribe takes long
    const release = s.slowSubscribe()
    s.feedLog(moduleChange(s, 21n))
    await tick()
    expect(s.fetcher.holding).toEqual(new Set([POOL_D]))
    // heads pass the pruning point of block 21, D keeps its id
    for (const head of [22n, 23n, 24n]) s.feedHead(head)
    expect(s.fetcher.applied.get(POOL_D)?.has(21n)).toBe(true)
    release()
    await tick()
    s.feedHead(25n)
    s.feedHead(26n)
    await tick()
    // the cover read of (19, 26] brought the Mint again, deduped
    expect(s.getLogs.mock.calls[2]![0]).toMatchObject({
      fromBlock: 20n,
      toBlock: 26n,
    })
    expect(poolD.liquidity).toBe(6n)
    expect(s.fetcher.gaps).toEqual([])
    expect(s.fetcher.holding.size).toBe(0)
  })

  it('keeps a hold another pending gap needs when one gap closes', async () => {
    const s = setup({ slipstream: true })
    await started(s)
    s.writesD()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    const poolD = s.slip.pools.get(POOL_D) as SlipstreamPool
    // the module moves at 18 while D's own gap is pending, the cover's
    // subscribe takes long
    const release = s.slowSubscribe()
    s.feedLog(moduleChange(s, 18n))
    await tick()
    expect(s.fetcher.gaps).toEqual([
      { pools: new Set([POOL_D]), readyAt: 19n },
      { pools: new Set([POOL_D]), readyAt: undefined },
    ])
    s.feedHead(19n)
    await tick()
    // D's own gap was read, D stays held for the cover
    expect(s.fetcher.gaps).toEqual([
      { pools: new Set([POOL_D]), readyAt: undefined },
    ])
    expect(s.fetcher.holding).toEqual(new Set([POOL_D]))
    expect(s.fetcher.complete.get(POOL_D)).toBe(19n)
    // the new module sets D's fee at 20, served by the read only
    s.readable_(
      rawLog(NEW_MODULE, EVENTS.customFeeSet, { pool: POOL_D, fee: 700 }, 20n),
    )
    s.feedHead(20n)
    s.feedHead(21n)
    s.feedHead(22n)
    expect(s.fetcher.complete.get(POOL_D)).toBe(19n)
    release()
    await tick()
    s.feedHead(23n)
    s.feedHead(24n)
    await tick()
    // the cover read starts where D's own read ended
    expect(s.getLogs.mock.calls[2]![0]).toMatchObject({
      fromBlock: 20n,
      toBlock: 24n,
    })
    expect(poolD.fee).toBe(700)
    expect(s.fetcher.holding.size).toBe(0)
    expect(s.fetcher.gaps).toEqual([])
  })

  it('starts the cover where a read applies the module change, before the held logs replay', async () => {
    const s = setup({ slipstream: true })
    await started(s, true)
    s.writesD()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    s.feedHead(19n)
    await tick()
    const poolD = s.slip.pools.get(POOL_D) as SlipstreamPool
    // a drop, the change at 20 is missed while down, and the new module
    // sets D's fee at 22, which the read of the whole does not ask for
    const current = [...s.subs]
      .reverse()
      .find((sub) => sub.params[0] === 'pendingLogs')!
    current.onError(new Error('socket closed'))
    await tick()
    expect(s.fetcher.drops).toBe(1)
    s.readable_(moduleChange(s, 20n))
    s.readable_(
      rawLog(NEW_MODULE, EVENTS.customFeeSet, { pool: POOL_D, fee: 700 }, 22n),
    )
    const releaseReads = s.holdReads()
    s.feedHead(21n)
    await tick()
    s.feedHead(22n)
    // a pending swap of D at 25, ahead of the cover read, arrives: held
    s.feedLog(swap(POOL_D, 3n * 2n ** 96n, 25n), 'pendingLogs')
    releaseReads()
    await tick()
    // the change applied and the cover held D before the replay moved it
    expect(s.slip.swapFeeModule[ChainId.BASE]!.toLowerCase()).toBe(NEW_MODULE)
    expect(s.fetcher.holding).toEqual(new Set([POOL_D]))
    expect(s.fetcher.held.length).toBe(1)
    expect(poolD.blockNumber).toBe(21n)
    s.feedHead(23n)
    s.feedHead(24n)
    await tick()
    // the cover read brought the new module's fee log, then the swap landed
    expect(poolD.fee).toBe(700)
    expect(poolD.sqrtPriceX96).toBe(3n * 2n ** 96n)
    expect(s.fetcher.held).toEqual([])
    expect(s.fetcher.gaps).toEqual([])
  })

  it('resets the fee settings of the pools a round covers, and keeps only the ones ahead pending', async () => {
    const s = setup({ slipstream: true })
    delete (s.slip as any).afterProcessLog
    const init = vi.fn(async () => true)
    ;(s.slip as any).initFeeModule = init
    const configs = vi.fn(async (pools: any[]) =>
      pools.map(() => ({ ...DEFAULT_FEE_CONFIG, baseFee: 500 })),
    )
    ;(s.slip as any).readFeeConfigs = configs
    ;(s.slip as any).readPoolFees = vi.fn(async () => [])
    // two pools, C is ahead of the first round
    s.slip.pools.set(POOL_D, {
      ...v3Pool(POOL_D, 19n),
      address: POOL_D,
      tickSpacing: 100,
      fee: 500,
      feeType: FeeType.Dynamic,
      feeConfig: { ...DEFAULT_FEE_CONFIG, baseFee: 500 },
    } as unknown as SlipstreamPool)
    s.slip.pools.set(POOL_C, {
      ...v3Pool(POOL_C, 21n),
      address: POOL_C,
      tickSpacing: 100,
      fee: 500,
      feeType: FeeType.Dynamic,
      feeConfig: { ...DEFAULT_FEE_CONFIG, baseFee: 500 },
    } as unknown as SlipstreamPool)
    s.slip.processLog(formatLog(moduleChange(s, 20n)) as Log)
    expect(s.slip.resetPending).toEqual(new Set([POOL_D, POOL_C]))
    expect(s.slip.resetFeesFrom).toBe(20n)
    await s.slip.afterProcessLog(20n)
    // the module read once, D's settings read, C stays pending
    expect(init).toHaveBeenCalledTimes(1)
    expect(configs.mock.calls[0]![0].map((p: any) => p.address)).toEqual([
      POOL_D,
    ])
    expect(s.slip.resetPending).toEqual(new Set([POOL_C]))
    expect(s.slip.shouldResetFees).toBe(true)
    await s.slip.afterProcessLog(21n)
    expect(init).toHaveBeenCalledTimes(1)
    expect(configs.mock.calls[1]![0].map((p: any) => p.address)).toEqual([
      POOL_C,
    ])
    expect(s.slip.resetPending.size).toBe(0)
    expect(s.slip.shouldResetFees).toBe(false)
    // a change log with no block, back to the first module, leaves the
    // reset to any round
    const back = rawLog(
      s.slip.factory[ChainId.BASE]!,
      EVENTS.swapFeeModuleChanged,
      { oldFeeModule: NEW_MODULE, newFeeModule: FEE_MODULE },
      25n,
    )
    const noBlock = { ...(formatLog(back) as Log), blockNumber: null }
    s.slip.processLog(noBlock as Log)
    expect(s.slip.shouldResetFees).toBe(true)
    expect(s.slip.resetFeesFrom).toBeUndefined()
  })

  it('takes a logs subscribe the node never answers as a drop while heads flow', async () => {
    const s = setup()
    const starting = s.fetcher.start(s.wsClient, {
      resubscribeDelay: 1,
      stallTimeout: 15,
    })
    await tick()
    s.feedHead(17n)
    await starting
    // the reopen's heads subscribe answers, its logs subscribe never does
    s.subscribe.mockImplementationOnce(async (args: Sub) => {
      s.subs.push(args)
      return { subscriptionId: '0xheads', unsubscribe: s.unsubscribe }
    })
    s.subscribe.mockImplementationOnce(
      (args: Sub) =>
        new Promise(() => {
          s.subs.push(args)
        }),
    )
    s.subs[1]!.onError(new Error('socket closed'))
    let head = 18n
    await waitFor(() => {
      s.feedHead(head++)
      return s.fetcher.drops >= 2 && s.fetcher.open
    }, 1000)
    expect(s.fetcher.drops).toBeGreaterThanOrEqual(2)
    expect(s.fetcher.open).toBe(true)
    await s.fetcher.stop()
  })

  it('takes a subscribe for fetched pools that gets no answer as a drop while heads flow', async () => {
    const s = setup()
    const starting = s.fetcher.start(s.wsClient, {
      resubscribeDelay: 1,
      stallTimeout: 15,
    })
    await tick()
    s.feedHead(17n)
    await starting
    s.subscribe.mockImplementationOnce(
      (args: Sub) =>
        new Promise(() => {
          s.subs.push(args)
        }),
    )
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    expect(s.fetcher.holding).toEqual(new Set([POOL_C]))
    // heads keep coming, the stall timer alone would never fire
    let head = 18n
    await waitFor(() => {
      s.feedHead(head++)
      return s.fetcher.drops >= 1 && s.fetcher.open
    }, 1000)
    expect(s.fetcher.drops).toBeGreaterThanOrEqual(1)
    // the reopen covers C with the rest
    expect(s.fetcher.subscribed.has(POOL_C)).toBe(true)
    await s.fetcher.stop()
  })
})

describe('RainDataFetcherStream.updatePools and stop', () => {
  it('ignores the heads and logs of a stale subscription after the stop', async () => {
    const s = setup()
    await started(s)
    const heads = s.subs[0]!
    const logs = s.subs[1]!
    await s.fetcher.stop()
    ;(s.v2.afterProcessLog as any).mockClear()
    heads.onData({ result: { number: numberToHex(30n) } })
    logs.onData({ result: swap(POOL_A, 9n * 2n ** 96n, 30n) })
    await tick()
    expect(s.fetcher.head).toBe(-1n)
    expect(s.poolA.sqrtPriceX96).toBe(2n * 2n ** 96n)
    expect(s.v2.afterProcessLog).not.toHaveBeenCalled()
  })

  it('runs only the due gap reads in stream mode, and the parent round outside it', async () => {
    const s = setup()
    const parent = vi
      .spyOn(RainDataFetcher.prototype, 'updatePools')
      .mockResolvedValue(true)
    expect(await s.fetcher.updatePools(5n)).toBe(true)
    expect(parent).toHaveBeenCalledWith(5n, true)
    // the parent's shouldWait goes through
    expect(await s.fetcher.updatePools(6n, false)).toBe(true)
    expect(parent).toHaveBeenLastCalledWith(6n, false)
    await started(s)
    expect(await s.fetcher.updatePools()).toBe(false)
    expect(parent).toHaveBeenCalledTimes(2)
    expect(s.getLogs).toHaveBeenCalledTimes(1)
    // a gap that is due runs in it
    s.writesC()
    await s.fetcher.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 17n,
    })
    await tick()
    expect(await s.fetcher.updatePools()).toBe(false)
    expect(s.getLogs).toHaveBeenCalledTimes(1)
    s.chain.head = 19n
    s.fetcher.head = 19n
    expect(await s.fetcher.updatePools()).toBe(false)
    expect(s.getLogs).toHaveBeenCalledTimes(2)
    expect(s.fetcher.gaps).toEqual([])
    parent.mockRestore()
    await s.fetcher.stop()
    expect(s.unsubscribe).toHaveBeenCalledTimes(3)
    expect(s.fetcher.wsClient).toBeUndefined()
    expect(s.fetcher.open).toBe(false)
    expect(s.fetcher.head).toBe(-1n)
    // an error after the stop is nothing
    s.subs[1]!.onError(new Error('late'))
    expect(s.fetcher.drops).toBe(0)
  })

  it('resets the bookkeeping with the pools', async () => {
    const s = setup()
    await started(s)
    s.feedLog(swap(POOL_A, 5n * 2n ** 96n, 18n))
    s.fetcher.reset()
    expect(s.v3.pools.size).toBe(0)
    expect(s.fetcher.admitted.size).toBe(0)
    expect(s.fetcher.complete.size).toBe(0)
    expect(s.fetcher.applied.size).toBe(0)
    await s.fetcher.stop()
  })
})
