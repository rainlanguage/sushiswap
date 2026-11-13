// the liquidity providers index must load before any provider file to
// avoid an import cycle that leaves the base classes undefined
import '../liquidity-providers/index.js'

import {
  http,
  Address,
  Hex,
  Log,
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
} from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChainId } from '../../chain/constants.js'
import { Token } from '../../currency/index.js'
import { AerodromeSlipstreamProvider } from '../liquidity-providers/AerodromeSlipstream.js'
import { AerodromeSlipstreamV2_1Provider } from '../liquidity-providers/AerodromeSlipstreamV2.js'
import { HydrexProvider } from '../liquidity-providers/Hydrex.js'
import { UniswapV3Provider } from '../liquidity-providers/UniswapV3.js'
import {
  NUMBER_OF_SURROUNDING_TICKS,
  bitmapIndex,
} from '../liquidity-providers/UniswapV3Base.js'
import { RainV3Pool } from './UniswapV3Base.js'
import { DEFAULT_FEE_CONFIG, FeeType } from './VelodromeSlipstreamBase.js'

// offline tests: an afterProcessLog() with nothing to update makes no rpc
// call, viem would still send an empty aggregate3 call for an empty list
const client = createPublicClient({ transport: http('http://localhost:1') })
const multicall = vi.spyOn(client, 'multicall')
const POOL = '0x2222222222222222222222222222222222222222' as Address
const POOL_2 = '0x4444444444444444444444444444444444444444' as Address
/** a pool with no plugin reads no plugin fee */
const NO_PLUGIN = '0x0000000000000000000000000000000000000000'
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

/** a cached pool at block 10 with every word around tick 0 read */
function pool(extra: Record<string, unknown> = {}): RainV3Pool {
  const p = {
    address: POOL,
    token0: WETH,
    token1: USDC,
    fee: 500,
    tickSpacing: 10,
    sqrtPriceX96: 1n,
    activeTick: 0,
    tick: 0,
    ticks: new Map(),
    reserve0: 0n,
    reserve1: 0n,
    liquidity: 0n,
    blockNumber: 10n,
    ...extra,
  } as unknown as RainV3Pool
  const min = bitmapIndex(-NUMBER_OF_SURROUNDING_TICKS, p.tickSpacing)
  const max = bitmapIndex(NUMBER_OF_SURROUNDING_TICKS, p.tickSpacing)
  for (let w = min; w <= max; w++) p.ticks.set(w, [])
  return p
}

afterEach(() => multicall.mockClear())

describe('afterProcessLog returns early with nothing to update', () => {
  it('univ3: a Swap inside the cached window queues nothing', async () => {
    const provider = new UniswapV3Provider(ChainId.BASE, client as any)
    const p = pool()
    provider.pools.set(POOL.toLowerCase(), p)
    provider.queueNewTicks(p)
    expect(provider.newTicksQueue).toEqual([])
    await provider.afterProcessLog(20n)
    expect(multicall).not.toHaveBeenCalled()
  })

  it('univ3: queue entries without words are dropped without a read', async () => {
    const provider = new UniswapV3Provider(ChainId.BASE, client as any)
    const p = pool()
    provider.newTicksQueue.push([p, []])
    await provider.afterProcessLog(20n)
    expect(multicall).not.toHaveBeenCalled()
    expect(provider.newTicksQueue).toEqual([])
  })

  it('univ3: empty lists make no read', async () => {
    const provider = new UniswapV3Provider(ChainId.BASE, client as any)
    expect(await provider.getTicksInner([[pool(), []]])).toEqual([new Map()])
    expect(await provider.getReserves([])).toEqual([])
    expect(await provider.getLiquidity([])).toEqual([])
    expect(multicall).not.toHaveBeenCalled()
  })

  it('slipstream: no fee reset and no volatile pool', async () => {
    // the plain module base never has a volatile pool
    const plain = new AerodromeSlipstreamV2_1Provider(
      ChainId.BASE,
      client as any,
    )
    plain.pools.set(
      POOL.toLowerCase(),
      pool({ feeType: FeeType.Default, feeConfig: { ...DEFAULT_FEE_CONFIG } }),
    )
    await plain.afterProcessLog(20n)
    // the dynamic module base with a pool whose fee is static
    const dynamic = new AerodromeSlipstreamProvider(ChainId.BASE, client as any)
    ;(dynamic as any).defaultScalingFactor[ChainId.BASE] = 0n
    dynamic.pools.set(
      POOL.toLowerCase(),
      pool({ feeType: FeeType.Default, feeConfig: { ...DEFAULT_FEE_CONFIG } }),
    )
    await dynamic.afterProcessLog(20n)
    expect(multicall).not.toHaveBeenCalled()
  })

  it('algebra integral 1.2: no cached pool and no balance to read', async () => {
    const provider = new HydrexProvider(ChainId.BASE, client as any)
    await provider.afterProcessLog(20n)
    expect(multicall).not.toHaveBeenCalled()
    // a pool cached ahead of the round takes no part in it either
    provider.pools.set(POOL.toLowerCase(), pool({ blockNumber: 30n }))
    await provider.afterProcessLog(20n)
    expect(multicall).not.toHaveBeenCalled()
  })
})

/** a formatted log of the given event of the provider's abi, the args as the event lays them out */
function logOf(
  abi: readonly any[],
  eventName: string,
  args: Record<string, unknown>,
  blockNumber: bigint,
  logIndex = 0,
): Log {
  const item = abi.find((e) => e.type === 'event' && e.name === eventName)!
  // viem leaves the topic of a zero valued indexed argument null
  const topics = encodeEventTopics({ abi: [item], eventName, args } as any).map(
    (t) => t ?? (`0x${'0'.repeat(64)}` as Hex),
  )
  const nonIndexed = item.inputs.filter((i: any) => !i.indexed)
  const data = nonIndexed.length
    ? encodeAbiParameters(
        nonIndexed,
        nonIndexed.map((i: any) => args[i.name]),
      )
    : '0x'
  return {
    address: POOL,
    topics,
    data,
    blockNumber,
    logIndex,
    transactionIndex: 0,
    blockHash: `0x${'0'.repeat(64)}` as Hex,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex,
    removed: false,
  } as unknown as Log
}

/** a multicall answer that waits until released */
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((r) => {
    release = r
  })
  return { promise, release }
}

describe('afterProcessLog keeps its fee re-reads to the given pools', () => {
  it('slipstream: the volatile fee re-read covers the scoped pools, every pool with no scope, none with an empty one', async () => {
    const provider = new AerodromeSlipstreamProvider(
      ChainId.BASE,
      client as any,
    )
    ;(provider as any).defaultScalingFactor[ChainId.BASE] = 0n
    const volatile = (address: Address) =>
      pool({
        address,
        feeType: FeeType.Dynamic,
        feeConfig: { ...DEFAULT_FEE_CONFIG, scalingFactor: 5n },
      })
    const a = volatile(POOL)
    const b = volatile(POOL_2)
    provider.pools.set(POOL.toLowerCase(), a)
    provider.pools.set(POOL_2.toLowerCase(), b)
    expect((provider as any).isVolatile(a)).toBe(true)
    const reads: string[][] = []
    ;(provider as any).readPoolFees = vi.fn(async (pools: any[]) => {
      reads.push(pools.map((p) => p.address))
      return pools.map(() => 700)
    })
    await provider.afterProcessLog(20n, new Set([POOL_2.toLowerCase()]))
    expect(reads).toEqual([[POOL_2]])
    expect(b.fee).toBe(700)
    await provider.afterProcessLog(20n)
    expect(reads).toEqual([[POOL_2], [POOL, POOL_2]])
    await provider.afterProcessLog(20n, new Set())
    expect(reads).toEqual([[POOL_2], [POOL, POOL_2]])
    expect(multicall).not.toHaveBeenCalled()
  })

  it('slipstream: an older round for another pool landing after a newer one still sets that pool, one for the same pool sets nothing', async () => {
    const provider = new AerodromeSlipstreamProvider(
      ChainId.BASE,
      client as any,
    )
    ;(provider as any).defaultScalingFactor[ChainId.BASE] = 0n
    const volatile = (address: Address) =>
      pool({
        address,
        feeType: FeeType.Dynamic,
        feeConfig: { ...DEFAULT_FEE_CONFIG, scalingFactor: 5n },
      })
    const a = volatile(POOL)
    const b = volatile(POOL_2)
    provider.pools.set(POOL.toLowerCase(), a)
    provider.pools.set(POOL_2.toLowerCase(), b)
    const rounds: { pools: string[]; resolve: (fees: number[]) => void }[] = []
    ;(provider as any).readPoolFees = vi.fn(
      (pools: any[]) =>
        new Promise((resolve) =>
          rounds.push({ pools: pools.map((p) => p.address), resolve }),
        ),
    )
    const round20 = provider.afterProcessLog(20n, new Set([POOL.toLowerCase()]))
    const round21 = provider.afterProcessLog(
      21n,
      new Set([POOL_2.toLowerCase()]),
    )
    expect(rounds.map((r) => r.pools)).toEqual([[POOL], [POOL_2]])
    // the newer round, for b, lands first
    rounds[1]!.resolve([700])
    await round21
    expect(b.fee).toBe(700)
    // the older round, for a, lands last: a is set, it was in no newer round
    rounds[0]!.resolve([600])
    await round20
    expect(a.fee).toBe(600)
    expect(b.fee).toBe(700)
    expect(provider.feeRoundBlocks.get(POOL.toLowerCase())).toBe(20n)
    expect(provider.feeRoundBlocks.get(POOL_2.toLowerCase())).toBe(21n)
    expect(provider.feeRoundBlock).toBe(21n)
    // an older round for a pool a newer round covered sets nothing
    const round19 = provider.afterProcessLog(19n, new Set([POOL.toLowerCase()]))
    rounds[2]!.resolve([500])
    await round19
    expect(a.fee).toBe(600)
    expect(provider.feeRoundBlocks.get(POOL.toLowerCase())).toBe(20n)
  })

  it('algebra integral 1.2: the plugin fee refresh covers the scoped pools only', async () => {
    const provider = new HydrexProvider(ChainId.BASE, client as any)
    const plugin = '0x3333333333333333333333333333333333333333'
    const a = pool({ plugin }) as any
    const b = pool({ address: POOL_2, plugin }) as any
    provider.pools.set(POOL.toLowerCase(), a)
    provider.pools.set(POOL_2.toLowerCase(), b)
    multicall.mockImplementationOnce(async () => [
      { status: 'success', result: 650 },
    ])
    await provider.afterProcessLog(20n, new Set([POOL_2.toLowerCase()]))
    expect(multicall).toHaveBeenCalledTimes(1)
    expect((multicall.mock.calls[0]![0] as any).contracts).toHaveLength(1)
    expect(b.fee).toBe(650)
    expect(a.fee).toBe(500)
    // no scope: both
    multicall.mockImplementationOnce(async () => [
      { status: 'success', result: 610 },
      { status: 'success', result: 620 },
    ])
    await provider.afterProcessLog(21n)
    expect((multicall.mock.calls[1]![0] as any).contracts).toHaveLength(2)
    expect(a.fee).toBe(610)
    expect(b.fee).toBe(620)
  })
})

describe('afterProcessLog adds the logs applied during its read back', () => {
  it('univ3: a mint into a fetched word while the words are read is added into the word', async () => {
    const provider = new UniswapV3Provider(ChainId.BASE, client as any)
    const p = pool()
    provider.pools.set(POOL.toLowerCase(), p)
    // a word outside the cached window, queued by a swap that moved there
    const max = bitmapIndex(NUMBER_OF_SURROUNDING_TICKS, p.tickSpacing)
    const word = max + 1
    const inWord = (slot: number) => (word * 256 + slot) * p.tickSpacing
    expect(bitmapIndex(inWord(5), p.tickSpacing)).toBe(word)
    provider.newTicksQueue.push([p, [word]])
    const read = deferred<any>()
    multicall.mockImplementationOnce(() => read.promise)
    const running = provider.afterProcessLog(20n)
    await Promise.resolve()
    expect(provider.tickReads.size).toBe(1)
    // a mint of the read's own block is inside what the read brings
    provider.handlePoolEvents(
      logOf(
        provider.eventsAbi,
        'Mint',
        {
          sender: POOL,
          owner: POOL,
          tickLower: inWord(1),
          tickUpper: 0,
          amount: 3n,
          amount0: 0n,
          amount1: 0n,
        },
        20n,
      ),
    )
    // a mint past the read's block into the fetched word, and into a
    // cached word, which keeps the live delta
    provider.handlePoolEvents(
      logOf(
        provider.eventsAbi,
        'Mint',
        {
          sender: POOL,
          owner: POOL,
          tickLower: inWord(9),
          tickUpper: 0,
          amount: 7n,
          amount0: 0n,
          amount1: 0n,
        },
        21n,
        1,
      ),
    )
    // and one onto a tick the read brings, past the read's block
    provider.handlePoolEvents(
      logOf(
        provider.eventsAbi,
        'Mint',
        {
          sender: POOL,
          owner: POOL,
          tickLower: inWord(5),
          tickUpper: 0,
          amount: 2n,
          amount0: 0n,
          amount1: 0n,
        },
        21n,
        2,
      ),
    )
    // the live word is not there yet, the cached word 0 took the uppers
    expect(p.ticks.get(word)).toBeUndefined()
    expect(p.ticks.get(0)).toEqual([{ index: 0, DLiquidity: -12n }])
    read.release([
      { status: 'success', result: [{ tick: inWord(5), liquidityNet: 100n }] },
    ])
    await running
    expect(provider.tickReads.size).toBe(0)
    // the fetched word, with the deltas past the read's block added, the
    // one of the read's block left out
    expect(p.ticks.get(word)).toEqual([
      { index: inWord(5), DLiquidity: 102n },
      { index: inWord(9), DLiquidity: 7n },
    ])
    expect(p.ticks.get(0)).toEqual([{ index: 0, DLiquidity: -12n }])
    // a mint after the read is a plain live one
    provider.handlePoolEvents(
      logOf(
        provider.eventsAbi,
        'Burn',
        {
          owner: POOL,
          tickLower: inWord(9),
          tickUpper: 0,
          amount: 7n,
          amount0: 0n,
          amount1: 0n,
        },
        22n,
      ),
    )
    expect(p.ticks.get(word)).toEqual([{ index: inWord(5), DLiquidity: 102n }])
    expect(p.ticks.get(0)).toEqual([{ index: 0, DLiquidity: -5n }])
  })

  it('univ3: a pool ahead of the round keeps its queued words for a later round', async () => {
    const provider = new UniswapV3Provider(ChainId.BASE, client as any)
    const due = pool()
    const ahead = pool({ address: POOL_2, blockNumber: 25n })
    const max = bitmapIndex(NUMBER_OF_SURROUNDING_TICKS, due.tickSpacing)
    provider.newTicksQueue.push([due, [max + 1]], [ahead, [max + 1]])
    multicall.mockImplementationOnce(async () => [
      { status: 'success', result: [] },
    ])
    await provider.afterProcessLog(20n)
    // one word read, the due pool's, the pool ahead stays queued
    expect((multicall.mock.calls[0]![0] as any).contracts).toHaveLength(1)
    expect(due.ticks.get(max + 1)).toEqual([])
    expect(provider.newTicksQueue).toEqual([[ahead, [max + 1]]])
    // a round at its block reads it
    multicall.mockImplementationOnce(async () => [
      { status: 'success', result: [] },
    ])
    await provider.afterProcessLog(25n)
    expect(provider.newTicksQueue).toEqual([])
    expect(ahead.ticks.get(max + 1)).toEqual([])
  })

  it('algebra integral 1.2: a pool ahead of the round keeps its balance read, and a failed read is queued again', async () => {
    const provider = new HydrexProvider(ChainId.BASE, client as any)
    const due = pool({ plugin: NO_PLUGIN })
    const ahead = pool({ address: POOL_2, blockNumber: 45n, plugin: NO_PLUGIN })
    provider.pools.set(POOL.toLowerCase(), due)
    provider.pools.set(POOL_2.toLowerCase(), ahead)
    provider.queueReserveRead(due)
    provider.queueReserveRead(ahead)
    provider.queueReserveRead(due)
    expect(provider.onSwapPluginFeeUpdatePools).toEqual([due, ahead])
    // the round at 40 reads the due pool's balances only, and that read fails
    multicall.mockImplementationOnce(async () => [
      { status: 'failure', error: new Error('rpc') },
      { status: 'failure', error: new Error('rpc') },
    ])
    await provider.afterProcessLog(40n)
    expect((multicall.mock.calls[0]![0] as any).contracts).toHaveLength(2)
    expect(due.reserve0).toBe(0n)
    // both wait for the next round, the failed one queued again once
    expect(provider.onSwapPluginFeeUpdatePools).toEqual([ahead, due])
  })

  it('univ3: a read that fails leaves the queue for the next try and drops what it tracked', async () => {
    const provider = new UniswapV3Provider(ChainId.BASE, client as any)
    const p = pool()
    provider.pools.set(POOL.toLowerCase(), p)
    const max = bitmapIndex(NUMBER_OF_SURROUNDING_TICKS, p.tickSpacing)
    provider.newTicksQueue.push([p, [max + 1]])
    multicall.mockImplementationOnce(() => Promise.reject(new Error('rpc')))
    await provider.afterProcessLog(20n)
    expect(provider.tickReads.size).toBe(0)
    expect(provider.newTicksQueue).toEqual([[p, [max + 1]]])
    expect(p.ticks.get(max + 1)).toBeUndefined()
  })

  it('algebra integral 1.2: a swap while the balances are read is added on top of the read', async () => {
    const provider = new HydrexProvider(ChainId.BASE, client as any)
    // the pool has no plugin, so no plugin fee is read, only its balances a
    // plugin fee swap asked for
    const p = pool({ plugin: NO_PLUGIN })
    provider.pools.set(POOL.toLowerCase(), p)
    provider.onSwapPluginFeeUpdatePools.push(p)
    const read = deferred<any>()
    multicall.mockImplementationOnce(() => read.promise)
    const running = provider.afterProcessLog(20n)
    await Promise.resolve()
    expect(provider.reserveReads.size).toBe(1)
    provider.handlePoolEvents(
      logOf(
        provider.eventsAbi,
        'Swap',
        {
          sender: POOL,
          recipient: POOL,
          amount0: 5n,
          amount1: -3n,
          sqrtPriceX96: 1n,
          liquidity: 9n,
          tick: 0,
          overrideFee: 0,
          pluginFee: 0,
        },
        21n,
      ),
    )
    expect(p.reserve0).toBe(5n)
    expect(p.reserve1).toBe(-3n)
    read.release([
      { status: 'success', result: 1000n },
      { status: 'success', result: 2000n },
    ])
    await running
    expect(provider.reserveReads.size).toBe(0)
    expect(p.reserve0).toBe(1005n)
    expect(p.reserve1).toBe(1997n)
    // the pool is not asked again until another plugin fee swap
    expect(provider.onSwapPluginFeeUpdatePools).toEqual([])
  })

  it('algebra integral 1.2: an older plugin fee round landing after a newer one sets nothing', async () => {
    const provider = new HydrexProvider(ChainId.BASE, client as any)
    const p = pool({
      plugin: '0x3333333333333333333333333333333333333333',
    }) as any
    provider.pools.set(POOL.toLowerCase(), p)
    const older = deferred<any>()
    const newer = deferred<any>()
    multicall
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    const round18 = provider.afterProcessLog(18n)
    const round19 = provider.afterProcessLog(19n)
    newer.release([{ status: 'success', result: 700 }])
    await round19
    expect(p.fee).toBe(700)
    expect(provider.pluginFeeRoundBlock).toBe(19n)
    older.release([{ status: 'success', result: 600 }])
    await round18
    expect(p.fee).toBe(700)
    expect(provider.pluginFeeRoundBlock).toBe(19n)
    // a round for another pool, older than the newest, still sets that
    // pool's fee: the rounds cover different pools
    const other = pool({
      address: POOL_2,
      plugin: '0x3333333333333333333333333333333333333333',
    }) as any
    provider.pools.set(POOL_2.toLowerCase(), other)
    multicall.mockImplementationOnce(async () => [
      { status: 'success', result: 640 },
    ])
    await provider.afterProcessLog(18n, new Set([POOL_2.toLowerCase()]))
    expect(other.fee).toBe(640)
    expect(p.fee).toBe(700)
    expect(provider.pluginFeeRoundBlock).toBe(19n)
    // a fetch reads the fee of a pool no round had, at a block behind the
    // rounds, it is no round: the fee is set and the round block stands
    multicall.mockImplementationOnce(async () => [
      { status: 'success', result: 650 },
    ])
    await provider.updatePluginFees([p], 18n)
    expect(p.fee).toBe(650)
    expect(provider.pluginFeeRoundBlock).toBe(19n)
  })

  it('algebra integral 1.2: an older balance read landing after a newer one sets nothing', async () => {
    const provider = new HydrexProvider(ChainId.BASE, client as any)
    const p = pool({ plugin: NO_PLUGIN })
    provider.pools.set(POOL.toLowerCase(), p)
    const older = deferred<any>()
    const newer = deferred<any>()
    provider.onSwapPluginFeeUpdatePools.push(p)
    multicall.mockImplementationOnce(() => older.promise)
    const round20 = provider.afterProcessLog(20n)
    provider.onSwapPluginFeeUpdatePools.push(p)
    multicall.mockImplementationOnce(() => newer.promise)
    const round21 = provider.afterProcessLog(21n)
    expect(provider.reserveReads.size).toBe(2)
    newer.release([
      { status: 'success', result: 1000n },
      { status: 'success', result: 2000n },
    ])
    await round21
    expect(p.reserve0).toBe(1000n)
    expect(p.reserve1).toBe(2000n)
    older.release([
      { status: 'success', result: 900n },
      { status: 'success', result: 1900n },
    ])
    await round20
    expect(p.reserve0).toBe(1000n)
    expect(p.reserve1).toBe(2000n)
    expect(provider.reserveReadBlock.get(POOL.toLowerCase())).toBe(21n)
    expect(provider.reserveReads.size).toBe(0)
  })
})
