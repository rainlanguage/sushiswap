// the liquidity providers index must load before any provider file to
// avoid an import cycle that leaves the base classes undefined
import '../liquidity-providers/index.js'

import {
  http,
  type Address,
  type Hex,
  type Log,
  type RpcLog,
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  formatLog,
  numberToHex,
  toEventSelector,
} from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChainId } from '../../chain/index.js'
import { Token } from '../../currency/index.js'
import { LiquidityProviders } from '../liquidity-providers/LiquidityProvider.js'
import { UniswapV4Provider } from '../liquidity-providers/UniswapV4.js'
import {
  UNISWAP_V4_NATIVE,
  UNISWAP_V4_ZERO_HOOKS,
  type UniswapV4PoolState,
} from '../liquidity-providers/UniswapV4Base.js'
import { RainDataFetcher } from './RainDataFetcher.js'
import { RainDataFetcherStream } from './RainDataFetcherStream.js'
import { UniswapV4EventsAbi } from './UniswapV4Base.js'

// offline tests, the reads are mocks
const client = createPublicClient({ transport: http('http://localhost:1') })
const multicall = vi.spyOn(client, 'multicall')
const request = vi.spyOn(client, 'request')
afterEach(() => {
  multicall.mockReset()
  request.mockReset()
})

const USDC = new Token({
  chainId: ChainId.ETHEREUM,
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  decimals: 6,
  symbol: 'USDC',
})
/** Ethereum mainnet ETH/USDC 0.05% pool */
const ID: Hex =
  '0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27'
const OTHER_ID: Hex = `0x${'ab'.repeat(32)}`
const POOL_MANAGER: Address = '0x000000000004444c5dc75cb358380d2e3de08a90'

/** a cached pool at block 100, price 1, tick 3, words -1 and 0 read, one tick at 50 */
const state = (
  extra: Partial<UniswapV4PoolState> = {},
): UniswapV4PoolState => ({
  currency0: UNISWAP_V4_NATIVE,
  currency1: USDC.address.toLowerCase() as Address,
  fee: 500,
  tickSpacing: 10,
  hooks: UNISWAP_V4_ZERO_HOOKS,
  id: ID,
  token0: {
    address: '',
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
    chainId: ChainId.ETHEREUM,
  },
  token1: USDC,
  sqrtPriceX96: 2n ** 96n,
  tick: 3,
  activeTick: 0,
  liquidity: 5n,
  ticks: new Map([
    [-1, []],
    [0, [{ index: 50, DLiquidity: 7n }]],
  ]),
  lpFee: 500,
  protocolFee: 0,
  swapFee: 500,
  blockNumber: 100n,
  ...extra,
})

/** a raw PoolManager log of the given event, each one its own tx */
let nextTx = 1
function rawLog(
  eventName: (typeof UniswapV4EventsAbi)[number]['name'],
  args: Record<string, unknown>,
  blockNumber: bigint,
  address: Address = POOL_MANAGER,
): RpcLog {
  const item = UniswapV4EventsAbi.find((e) => e.name === eventName)!
  const topics = encodeEventTopics({
    abi: [item],
    eventName,
    args,
  } as any) as Hex[]
  const nonIndexed = item.inputs.filter((i) => !i.indexed)
  const data = nonIndexed.length
    ? encodeAbiParameters(
        nonIndexed,
        nonIndexed.map((i) => args[i.name as string]),
      )
    : '0x'
  return {
    address,
    topics,
    data,
    blockNumber: numberToHex(blockNumber),
    logIndex: '0x0',
    transactionIndex: '0x0',
    blockHash: `0x${'0'.repeat(64)}`,
    transactionHash: `0x${(nextTx++).toString(16).padStart(64, '0')}`,
    removed: false,
  } as unknown as RpcLog
}
const log = (...args: Parameters<typeof rawLog>) => formatLog(rawLog(...args))

const swap = (tick: number, blockNumber: bigint, liquidity = 9n) =>
  log(
    'Swap',
    {
      id: ID,
      sender: POOL_MANAGER,
      amount0: -1n,
      amount1: 1n,
      sqrtPriceX96: 3n * 2n ** 96n,
      liquidity,
      tick,
      fee: 500,
    },
    blockNumber,
  )
const modify = (
  tickLower: number,
  tickUpper: number,
  liquidityDelta: bigint,
  blockNumber: bigint,
) =>
  log(
    'ModifyLiquidity',
    {
      id: ID,
      sender: POOL_MANAGER,
      tickLower,
      tickUpper,
      liquidityDelta,
      salt: `0x${'0'.repeat(64)}`,
    },
    blockNumber,
  )

/** a multicall answer that waits until released */
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((r) => {
    release = r
  })
  return { promise, release }
}

describe('UniswapV4 rain provider logs', () => {
  it('applies a Swap of a cached pool and queues the words the new price needs', () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    const pool = state()
    provider.pools.set(ID, pool)
    expect(provider.processLog(swap(3000, 101n))).toBe(false)
    expect(pool).toMatchObject({
      sqrtPriceX96: 3n * 2n ** 96n,
      liquidity: 9n,
      tick: 3000,
      activeTick: 3000,
      blockNumber: 101n,
    })
    // the words 0 and 1 around tick 3000, word 0 is read
    expect(provider.newTicksQueue).toEqual([[pool, [1]]])
    // an older log than the pool's state, and a log of another contract
    provider.processLog(swap(-5000, 99n))
    provider.processLog(
      log(
        'Swap',
        {
          id: ID,
          sender: POOL_MANAGER,
          amount0: 0n,
          amount1: 0n,
          sqrtPriceX96: 1n,
          liquidity: 1n,
          tick: -9000,
          fee: 0,
        },
        102n,
        '0x1111111111111111111111111111111111111111',
      ),
    )
    expect(pool.tick).toBe(3000)
    expect(pool.blockNumber).toBe(101n)
  })

  it('changes the liquidity in range and the ticks of the read words with a ModifyLiquidity', () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    const pool = state()
    provider.pools.set(ID, pool)
    // in range of tick 3
    provider.processLog(modify(-10, 50, 4n, 101n))
    expect(pool.liquidity).toBe(9n)
    expect(pool.ticks.get(-1)).toEqual([{ index: -10, DLiquidity: 4n }])
    expect(pool.ticks.get(0)).toEqual([{ index: 50, DLiquidity: 3n }])
    // out of range, the liquidity stays, the ticks of the read word change
    provider.processLog(modify(100, 200, 2n, 102n))
    expect(pool.liquidity).toBe(9n)
    expect(pool.ticks.get(0)).toEqual([
      { index: 50, DLiquidity: 3n },
      { index: 100, DLiquidity: 2n },
      { index: 200, DLiquidity: -2n },
    ])
    // a tick in a word not read takes no change, a tick whose net ends at zero goes
    provider.processLog(modify(50, 9000, 3n, 103n))
    expect(pool.ticks.get(0)).toEqual([
      { index: 50, DLiquidity: 6n },
      { index: 100, DLiquidity: 2n },
      { index: 200, DLiquidity: -2n },
    ])
    expect(pool.ticks.has(3)).toBe(false)
    provider.processLog(modify(100, 200, -2n, 104n))
    expect(pool.ticks.get(0)).toEqual([{ index: 50, DLiquidity: 6n }])
    expect(pool.blockNumber).toBe(104n)
  })

  it('takes a ProtocolFeeUpdated into the swap fee', () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    const pool = state()
    provider.pools.set(ID, pool)
    provider.processLog(
      log(
        'ProtocolFeeUpdated',
        { id: ID, protocolFee: 100 | (200 << 12) },
        101n,
      ),
    )
    expect(pool.protocolFee).toBe(100 | (200 << 12))
    expect(pool.swapFee).toBe(700)
  })

  it('takes a null pool out of the null pools with its Initialize log', () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    provider.nullPools.set(OTHER_ID, 2)
    const initialize = log(
      'Initialize',
      {
        id: OTHER_ID,
        currency0: UNISWAP_V4_NATIVE,
        currency1: USDC.address,
        fee: 3000,
        tickSpacing: 60,
        hooks: UNISWAP_V4_ZERO_HOOKS,
        sqrtPriceX96: 2n ** 96n,
        tick: 0,
      },
      101n,
    )
    expect(provider.processLog(initialize)).toBe(true)
    expect(provider.nullPools.has(OTHER_ID)).toBe(false)
    // a second time it was no null pool
    expect(provider.processLog(initialize)).toBe(false)
  })
})

describe('UniswapV4 rain provider tick words', () => {
  /** answers the word reads: word 1 has a tick at 2580 with net 11 */
  const words = (bitmap = deferred<any>()) => {
    multicall.mockImplementation((async (args: any) => {
      const fn = args.contracts[0]?.functionName
      if (fn === 'getTickBitmap') {
        const answer = args.contracts.map((c: any) => ({
          status: 'success',
          result: c.args[1] === 1 ? 1n << 2n : 0n,
        }))
        bitmap.release(answer)
        return bitmap.promise
      }
      return args.contracts.map(() => ({
        status: 'success',
        result: [11n, 11n],
      }))
    }) as any)
  }

  it('reads the queued words at the round block, a pool ahead of it waits', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    const pool = state()
    const ahead = state({ id: OTHER_ID, blockNumber: 120n })
    provider.pools.set(ID, pool)
    provider.pools.set(OTHER_ID, ahead)
    provider.queueWords(pool, [1])
    provider.queueWords(ahead, [1])
    words()
    await provider.afterProcessLog(110n)
    multicall.mock.calls.forEach(([args]) =>
      expect((args as any).blockNumber).toBe(110n),
    )
    const read = (multicall.mock.calls[0]![0] as any).contracts.map(
      (c: any) => c.args,
    )
    expect(read).toEqual([[ID, 1]])
    expect(pool.ticks.get(1)).toEqual([{ index: 2580, DLiquidity: 11n }])
    expect(provider.newTicksQueue).toEqual([[ahead, [1]]])
  })

  it('queues the words of the pool object the provider holds, a replaced object takes none', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    const old = state()
    provider.pools.set(ID, old)
    provider.queueWords(old, [1])
    // a fetch puts a new object of the same pool in its place
    const fresh = state()
    provider.pools.set(ID, fresh)
    provider.queueWords(fresh, [2])
    provider.queueWords(old, [3])
    expect(provider.newTicksQueue.map(([p, w]) => [p === fresh, w])).toEqual([
      [false, [1]],
      [true, [2]],
    ])
    words()
    await provider.afterProcessLog(110n)
    // the word of the new object lands, the one of the replaced object is dropped
    expect(fresh.ticks.has(2)).toBe(true)
    expect(old.ticks.has(1)).toBe(false)
    expect(provider.newTicksQueue).toEqual([])
  })

  it('queues the words of a failed read again', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    const pool = state()
    provider.pools.set(ID, pool)
    provider.queueWords(pool, [1, 2])
    multicall.mockImplementation((() =>
      Promise.reject(new Error('rpc'))) as any)
    await provider.afterProcessLog(110n)
    expect(provider.newTicksQueue).toEqual([[pool, [1, 2]]])
    expect(pool.ticks.has(1)).toBe(false)
  })

  it('adds a mint past the read block into the word the read brings back', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    const pool = state()
    provider.pools.set(ID, pool)
    provider.queueWords(pool, [1])
    const bitmap = deferred<any>()
    let landed = false
    multicall.mockImplementation((async (args: any) => {
      const fn = args.contracts[0]?.functionName
      if (fn === 'getTickBitmap') {
        await bitmap.promise
        landed = true
        return args.contracts.map(() => ({
          status: 'success',
          result: 1n << 2n,
        }))
      }
      return args.contracts.map(() => ({
        status: 'success',
        result: [11n, 11n],
      }))
    }) as any)
    const running = provider.afterProcessLog(110n)
    await Promise.resolve()
    expect(provider.tickReads.size).toBe(1)
    // a mint of the read's block is inside the read, one past it is added back
    provider.processLog(modify(2600, 9000, 5n, 110n))
    provider.processLog(modify(2610, 9000, 4n, 111n))
    expect(pool.ticks.has(1)).toBe(false)
    bitmap.release(undefined)
    await running
    expect(landed).toBe(true)
    expect(provider.tickReads.size).toBe(0)
    expect(pool.ticks.get(1)).toEqual([
      { index: 2580, DLiquidity: 11n },
      { index: 2610, DLiquidity: 4n },
    ])
  })

  it('adds no tick change of a log at or before the block a word was read at into that word, the liquidity in range still takes it', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    const pool = state()
    provider.pools.set(ID, pool)
    provider.queueWords(pool, [1])
    words()
    await provider.afterProcessLog(110n)
    expect(pool.wordBlocks?.get(1)).toBe(110n)
    // a log of the read's block that comes after the read, the word holds it
    provider.processLog(modify(0, 2600, 4n, 110n))
    expect(pool.ticks.get(1)).toEqual([{ index: 2580, DLiquidity: 11n }])
    expect(pool.liquidity).toBe(9n)
    // a log past the read's block changes the word
    provider.processLog(modify(0, 2600, 2n, 111n))
    expect(pool.ticks.get(1)).toEqual([
      { index: 2580, DLiquidity: 11n },
      { index: 2600, DLiquidity: -2n },
    ])
    expect(pool.liquidity).toBe(11n)
  })
})

describe('UniswapV4 rain provider PoolManager log read', () => {
  const selector = (name: string) =>
    toEventSelector(UniswapV4EventsAbi.find((e) => e.name === name)!)
  const updates = ['Swap', 'ModifyLiquidity', 'ProtocolFeeUpdated'].map(
    selector,
  )
  const filter = (topics: unknown[]) => ({
    address: POOL_MANAGER,
    topics,
    fromBlock: '0x65',
    toBlock: '0x6e',
  })

  it('reads the update logs of the cached pools by id, the ids in chunks', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    provider.logIdsPerRead = 2
    const ids = [ID, OTHER_ID, `0x${'cd'.repeat(32)}`]
    request.mockImplementation((async () => [
      rawLog('ProtocolFeeUpdated', { id: ID, protocolFee: 0 }, 105n),
    ]) as any)
    const logs = await provider.getPoolManagerLogs(ids, 101n, 110n)
    expect(request.mock.calls.map(([a]) => (a as any).params[0])).toEqual([
      filter([updates, [ID, OTHER_ID]]),
      filter([updates, [`0x${'cd'.repeat(32)}`]]),
    ])
    // the logs come formatted
    expect(logs).toHaveLength(2)
    expect(logs[0]!.blockNumber).toBe(105n)
  })

  it('reads no Initialize log, those come with the factory logs, and reads nothing with no ids', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    provider.nullPools.set(OTHER_ID, 2)
    request.mockImplementation((async () => []) as any)
    await provider.getPoolManagerLogs([ID], 101n, 110n)
    expect(request.mock.calls.map(([a]) => (a as any).params[0])).toEqual([
      filter([updates, [ID]]),
    ])
    expect(await provider.getPoolManagerLogs([], 101n, 110n)).toEqual([])
    expect(request).toHaveBeenCalledTimes(1)
    expect(provider.eventsAbi.map((e) => toEventSelector(e))).toEqual([
      selector('Initialize'),
    ])
  })
})

describe('RainDataFetcher with Uniswap V4 pools', () => {
  /**
   * a fetcher with only the V4 provider, as initProviders sets it up: the
   * PoolManager is a factory and the Initialize event is in the events. Its
   * address based read is a mock
   */
  const setup = () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    const fetcher = new RainDataFetcher(ChainId.ETHEREUM, client)
    const getLogs = vi.fn(async (_args: any): Promise<Log[]> => [])
    Object.assign(fetcher, {
      providers: [provider],
      web3Client: { getBlockNumber: vi.fn(async () => 110n), getLogs },
      eventsAbi: [...provider.eventsAbi],
      factories: [POOL_MANAGER],
    })
    return { provider, fetcher, getLogs }
  }

  it('reads the PoolManager logs of the pools behind the round by id and applies the newer ones', async () => {
    const { provider, fetcher, getLogs } = setup()
    const pool = state()
    provider.pools.set(ID, pool)
    provider.nullPools.set(OTHER_ID, 2)
    // the address based read brings the Initialize logs of the PoolManager
    getLogs.mockImplementation(async () =>
      [
        rawLog(
          'Initialize',
          {
            id: OTHER_ID,
            currency0: UNISWAP_V4_NATIVE,
            currency1: USDC.address,
            fee: 3000,
            tickSpacing: 60,
            hooks: UNISWAP_V4_ZERO_HOOKS,
            sqrtPriceX96: 2n ** 96n,
            tick: 0,
          },
          106n,
        ),
        // the Initialize of a pool no fetch read is dropped
        rawLog(
          'Initialize',
          {
            id: `0x${'cd'.repeat(32)}`,
            currency0: UNISWAP_V4_NATIVE,
            currency1: USDC.address,
            fee: 100,
            tickSpacing: 1,
            hooks: UNISWAP_V4_ZERO_HOOKS,
            sqrtPriceX96: 2n ** 96n,
            tick: 0,
          },
          107n,
        ),
      ].map((log) => formatLog(log) as Log),
    )
    // the update read of the cached pool, by its id
    request.mockImplementation((async () => [
      // a log of the pool's own state block is in its state already
      rawLog(
        'ModifyLiquidity',
        {
          id: ID,
          sender: POOL_MANAGER,
          tickLower: -10,
          tickUpper: 50,
          liquidityDelta: 1000n,
          salt: `0x${'0'.repeat(64)}`,
        },
        100n,
      ),
      rawLog(
        'Swap',
        {
          id: ID,
          sender: POOL_MANAGER,
          amount0: -1n,
          amount1: 1n,
          sqrtPriceX96: 3n * 2n ** 96n,
          liquidity: 9n,
          tick: 40,
          fee: 500,
        },
        105n,
      ),
    ]) as any)
    // a null pool told to exist is a created pool
    expect(await fetcher.updatePools(110n)).toBe(true)
    expect(getLogs).toHaveBeenCalledTimes(1)
    expect(getLogs.mock.calls[0]![0]).toMatchObject({
      address: [POOL_MANAGER],
      events: provider.eventsAbi,
      fromBlock: 101n,
      toBlock: 110n,
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect((request.mock.calls[0]![0] as any).params[0].topics[1]).toEqual([ID])
    expect(pool.liquidity).toBe(9n)
    expect(pool.tick).toBe(40)
    // the ModifyLiquidity of block 100 was skipped, its ticks are not there
    expect(pool.ticks.get(-1)).toEqual([])
    expect(pool.ticks.get(0)).toEqual([{ index: 50, DLiquidity: 7n }])
    expect(pool.blockNumber).toBe(110n)
    expect(provider.nullPools.has(OTHER_ID)).toBe(false)
  })

  it('stops the round at a failed PoolManager read', async () => {
    const { provider, fetcher } = setup()
    const pool = state()
    provider.pools.set(ID, pool)
    request.mockImplementation((() => Promise.reject(new Error('rpc'))) as any)
    expect(await fetcher.updatePools(110n)).toBe(false)
    expect(pool.blockNumber).toBe(100n)
  })

  it('leaves out a pool at or past the round block', async () => {
    const { provider, fetcher } = setup()
    provider.pools.set(ID, state({ blockNumber: 110n }))
    expect(await fetcher.updatePools(110n)).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('is in the RainDataFetcher and the stream providers', async () => {
    const lps = [LiquidityProviders.UniswapV4]
    const fetcher = await RainDataFetcher.init(
      ChainId.ETHEREUM,
      client,
      lps,
      1n,
    )
    expect(fetcher.providers.some((p) => p instanceof UniswapV4Provider)).toBe(
      true,
    )
    // the PoolManager is read as a factory, for its Initialize logs
    expect(fetcher.factories).toEqual([POOL_MANAGER])
    expect(fetcher.eventsAbi).toEqual([UniswapV4EventsAbi[0]])
    const stream = await RainDataFetcherStream.init(
      ChainId.ETHEREUM,
      client,
      lps,
      1n,
    )
    expect(stream.providers.some((p) => p instanceof UniswapV4Provider)).toBe(
      true,
    )
  })
})
