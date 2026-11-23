// the liquidity providers index must load before any provider file to
// avoid an import cycle that leaves the base classes undefined
import './index.js'

import { http, createPublicClient } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChainId } from '../../chain/index.js'
import { Native, Token } from '../../currency/index.js'
import { RToken, UniV4Pool } from '../../tines/index.js'
import { UniV4PoolCode } from '../pool-codes/index.js'
import type { RainDataFetcherOptions } from '../rain/RainDataFetcher.js'
import { Router } from '../router.js'
import { getRouteProcessor4Code } from '../tines-to-route-processor-4.js'
import { getRouteProcessor6Code } from '../tines-to-route-processor-6.js'
import { LiquidityProviders } from './LiquidityProvider.js'
import { UniswapV4Provider } from './UniswapV4.js'
import {
  UNISWAP_V4_DYNAMIC_FEE_FLAG,
  UNISWAP_V4_NATIVE,
  UNISWAP_V4_ZERO_HOOKS,
  UniswapV4BaseProvider as PlainUniswapV4BaseProvider,
  computeUniswapV4PoolId,
  isUniswapV4PoolSupported,
  uniswapV4SwapFee,
} from './UniswapV4Base.js'

// offline tests, the multicalls are mocks
const client = createPublicClient({ transport: http('http://localhost:1') })
const multicall = vi.spyOn(client, 'multicall')
afterEach(() => (multicall as any).mockReset())

const USDC = new Token({
  chainId: ChainId.ETHEREUM,
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  decimals: 6,
  symbol: 'USDC',
  name: 'USD Coin',
})
const WETH = new Token({
  chainId: ChainId.ETHEREUM,
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  decimals: 18,
  symbol: 'WETH',
  name: 'Wrapped Ether',
})
/** Ethereum mainnet ETH/USDC 0.05% pool */
const ETH_USDC_500 =
  '0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27'

describe('UniswapV4Base helpers', () => {
  it('computes the pool id like PoolId.toId(PoolKey), whatever the address case', () => {
    const key = {
      currency0: UNISWAP_V4_NATIVE,
      currency1: USDC.address as `0x${string}`,
      fee: 500,
      tickSpacing: 10,
      hooks: UNISWAP_V4_ZERO_HOOKS,
    }
    expect(computeUniswapV4PoolId(key)).toBe(ETH_USDC_500)
    expect(
      computeUniswapV4PoolId({
        ...key,
        currency1: USDC.address.toLowerCase() as `0x${string}`,
      }),
    ).toBe(ETH_USDC_500)
  })

  it('supports pools without hooks and with a static fee', () => {
    expect(
      isUniswapV4PoolSupported({ fee: 3000, hooks: UNISWAP_V4_ZERO_HOOKS }),
    ).toBe(true)
  })

  it('rejects dynamic fee pools', () => {
    expect(
      isUniswapV4PoolSupported({
        fee: UNISWAP_V4_DYNAMIC_FEE_FLAG,
        hooks: UNISWAP_V4_ZERO_HOOKS,
      }),
    ).toBe(false)
  })

  it('rejects hooks that run before a swap or return swap deltas', () => {
    const supported = (hooks: `0x${string}`) =>
      isUniswapV4PoolSupported({ fee: 3000, hooks })
    // BEFORE_SWAP_FLAG = 1 << 7
    expect(supported('0x0000000000000000000000000000000000000080')).toBe(false)
    // BEFORE_SWAP_RETURNS_DELTA_FLAG = 1 << 3
    expect(supported('0x0000000000000000000000000000000000000008')).toBe(false)
    // AFTER_SWAP_RETURNS_DELTA_FLAG = 1 << 2, with AFTER_SWAP_FLAG
    expect(supported('0x0000000000000000000000000000000000000044')).toBe(false)
  })

  it('accepts hooks that run after a swap, or on initialize, liquidity changes and donations', () => {
    const supported = (hooks: `0x${string}`) =>
      isUniswapV4PoolSupported({ fee: 3000, hooks })
    // AFTER_SWAP_FLAG = 1 << 6
    expect(supported('0x0000000000000000000000000000000000000040')).toBe(true)
    // BEFORE_INITIALIZE, AFTER_INITIALIZE, the four liquidity flags
    expect(supported('0x0000000000000000000000000000000000003f00')).toBe(true)
    // BEFORE_DONATE, AFTER_DONATE, the two liquidity return delta flags
    expect(supported('0x0000000000000000000000000000000000000033')).toBe(true)
  })

  it('takes the protocol fee of the costlier direction into the swap fee', () => {
    expect(uniswapV4SwapFee(3000, 0)).toBe(3000)
    // zeroForOne 100, oneForZero 200: 200 + 3000 - floor(200 * 3000 / 1e6)
    expect(uniswapV4SwapFee(3000, 100 | (200 << 12))).toBe(3200)
    // 1000 + 500_000 - 500 for zeroForOne
    expect(uniswapV4SwapFee(500_000, 1000)).toBe(500_500)
  })
})

describe('UniswapV4Provider', () => {
  it('adds the native variant of every pair with the wrapped native token', () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    const pools = provider.getStaticPools(WETH, USDC)
    const native = pools.find((p) => p.id === ETH_USDC_500)!
    expect(native).toBeDefined()
    expect(native.currency0).toBe(UNISWAP_V4_NATIVE)
    expect(native.token0.address).toBe('')
    expect(native.token1.address).toBe(USDC.address)
    // the wrapped pair is there as well, sorted by address
    const wrapped = pools.find(
      (p) =>
        p.currency0 === USDC.address.toLowerCase() &&
        p.currency1 === WETH.address.toLowerCase() &&
        p.fee === 500,
    )
    expect(wrapped).toBeDefined()
    // ids are unique
    expect(new Set(pools.map((p) => p.id)).size).toBe(pools.length)
  })

  /** answers the reads: only the ETH/USDC 0.05% pool exists, price 1, one tick at 50 */
  const mockChain = (failTicks = false) =>
    multicall.mockImplementation((async (args: any) => {
      const fn = args.contracts[0]?.functionName
      if (fn === 'getSlot0')
        return args.contracts.map((c: any) => ({
          status: 'success',
          result:
            c.args[0] === ETH_USDC_500 ? [2n ** 96n, 3, 0, 500] : [0n, 0, 0, 0],
        }))
      if (fn === 'getLiquidity')
        return args.contracts.map(() => ({ status: 'success', result: 5n }))
      if (fn === 'getTickBitmap')
        return args.contracts.map((c: any) => ({
          status: 'success',
          result: c.args[1] === 0 ? 1n << 5n : 0n,
        }))
      if (fn === 'getTickLiquidity')
        return args.contracts.map(() =>
          failTicks
            ? { status: 'failure', error: new Error('rpc') }
            : { status: 'success', result: [7n, 7n] },
        )
      throw new Error(`unexpected read ${fn}`)
    }) as any)

  it('reads the pools at the given block and lists the ones of the trade', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    mockChain()
    await provider.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 123n,
    })
    // every read is pinned to the block
    expect(multicall).toHaveBeenCalledTimes(4)
    multicall.mock.calls.forEach(([args]) =>
      expect((args as any).blockNumber).toBe(123n),
    )
    // the words around tick 0 with spacing 10 are -1 and 0
    const words = (multicall.mock.calls[2]![0] as any).contracts.map(
      (c: any) => c.args[1],
    )
    expect(words).toEqual([-1, 0])
    const state = provider.pools.get(ETH_USDC_500)!
    expect(state).toMatchObject({
      tick: 3,
      activeTick: 0,
      liquidity: 5n,
      lpFee: 500,
      swapFee: 500,
      blockNumber: 123n,
    })
    // the ticks by word, and for tines between the bounds of the read words
    expect(state.ticks).toEqual(
      new Map([
        [-1, []],
        [0, [{ index: 50, DLiquidity: 7n }]],
      ]),
    )
    // every word is read at the fetch block
    expect(state.wordBlocks).toEqual(
      new Map([
        [-1, 123n],
        [0, 123n],
      ]),
    )
    expect(provider.tickList(state)).toEqual([
      { index: -2570, DLiquidity: 0n },
      { index: 50, DLiquidity: 7n },
      { index: 2560, DLiquidity: 0n },
    ])
    expect(provider.pools.size).toBe(1)

    const list = provider.getCurrentPoolList(WETH, USDC)
    expect(list).toHaveLength(1)
    const code = list[0] as UniV4PoolCode
    expect(code).toBeInstanceOf(UniV4PoolCode)
    expect(code.poolKey).toEqual({
      currency0: UNISWAP_V4_NATIVE,
      currency1: USDC.address.toLowerCase(),
      fee: 500,
      tickSpacing: 10,
      hooks: UNISWAP_V4_ZERO_HOOKS,
    })
    const pool = code.pool as UniV4Pool
    expect(pool).toBeInstanceOf(UniV4Pool)
    expect(pool.fee).toBe(0.0005)
    expect(pool.token0.address).toBe('')
    expect(pool.uniqueID()).toBe(ETH_USDC_500 + provider.getPoolManager())
    expect(code.getSwapCodeForRouteProcessor4()).toBe('unsupported')
    // the cached words stay as they are, the tines pool adds bounds to its own list
    expect(state.ticks.get(0)).toHaveLength(1)
    // another trade does not list the pool
    const DAI = new Token({
      chainId: ChainId.ETHEREUM,
      address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      decimals: 18,
      symbol: 'DAI',
    })
    expect(provider.getCurrentPoolList(DAI, WETH)).toEqual([])
  })

  it('does not read a cached pool again when ignoreCache is false', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    mockChain()
    await provider.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 123n,
    })
    multicall.mockClear()
    // the provider takes DataFetcherOptions, ignoreCache is a RainDataFetcher option
    const options: RainDataFetcherOptions = {
      blockNumber: 124n,
      ignoreCache: false,
    }
    await provider.fetchPoolsForToken(WETH, USDC, undefined, options)
    const read = (multicall.mock.calls[0]![0] as any).contracts.map(
      (c: any) => c.args[0],
    )
    expect(read).not.toContain(ETH_USDC_500)
    expect(provider.pools.get(ETH_USDC_500)!.blockNumber).toBe(123n)
  })

  it('does not list an excluded pool that another trade cached', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    mockChain()
    await provider.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 123n,
    })
    expect(provider.pools.has(ETH_USDC_500)).toBe(true)
    const DAI = new Token({
      chainId: ChainId.ETHEREUM,
      address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      decimals: 18,
      symbol: 'DAI',
    })
    // the pool is a candidate of DAI/WETH too, through the USDC base token
    expect(
      provider.getStaticPools(DAI, WETH).some((p) => p.id === ETH_USDC_500),
    ).toBe(true)
    await provider.fetchPoolsForToken(DAI, WETH, new Set([ETH_USDC_500]), {
      blockNumber: 124n,
    })
    const ids = provider
      .getCurrentPoolList(DAI, WETH)
      .map((code) => (code.pool as UniV4Pool).id)
    expect(ids).not.toContain(ETH_USDC_500)
  })

  it('reads at the latest block when none is given', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    const getBlockNumber = vi
      .spyOn(client, 'getBlockNumber')
      .mockResolvedValue(456n)
    mockChain()
    await provider.fetchPoolsForToken(WETH, USDC)
    expect(getBlockNumber).toHaveBeenCalledTimes(1)
    multicall.mock.calls.forEach(([args]) =>
      expect((args as any).blockNumber).toBe(456n),
    )
    expect(provider.pools.get(ETH_USDC_500)!.blockNumber).toBe(456n)
    getBlockNumber.mockRestore()
  })

  it('skips a pool whose tick read failed', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    mockChain(true)
    await provider.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 123n,
    })
    expect(provider.pools.size).toBe(0)
  })

  /** the pool ids the slot0 read of each fetch asked for */
  const slot0Reads = () =>
    multicall.mock.calls
      .map(([args]) => args as any)
      .filter((args) => args.contracts[0]?.functionName === 'getSlot0')
      .map((args) => args.contracts.map((c: any) => c.args[0]))

  it('keeps the ids with no pool and does not read one again after its second miss', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    mockChain()
    const options = { blockNumber: 123n, ignoreCache: false }
    await provider.fetchPoolsForToken(WETH, USDC, undefined, options)
    const ids = slot0Reads()[0]!
    const missing = ids.filter((id: string) => id !== ETH_USDC_500)
    missing.forEach((id: string) => expect(provider.nullPools.get(id)).toBe(1))
    expect(provider.nullPools.has(ETH_USDC_500)).toBe(false)
    // the second fetch reads the missing ids again, the cached pool not
    multicall.mockClear()
    await provider.fetchPoolsForToken(WETH, USDC, undefined, options)
    expect(slot0Reads()[0]).toEqual(missing)
    missing.forEach((id: string) => expect(provider.nullPools.get(id)).toBe(2))
    // after the second miss nothing is left to read
    multicall.mockClear()
    await provider.fetchPoolsForToken(WETH, USDC, undefined, options)
    expect(multicall).not.toHaveBeenCalled()
    // without ignoreCache, as DataFetcher fetches, every id is read
    multicall.mockClear()
    await provider.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 124n,
    })
    expect(slot0Reads()[0]).toEqual(ids)
  })

  it('resets the pools and the null pools, the Initialize scans stay', async () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    mockChain()
    await provider.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 123n,
    })
    provider.initializeScans.set('a:b', { through: 9n, pools: new Map() })
    expect(provider.pools.size).toBe(1)
    expect(provider.nullPools.size).toBeGreaterThan(0)
    provider.reset()
    expect(provider.pools.size).toBe(0)
    expect(provider.poolsByTrade.size).toBe(0)
    expect(provider.nullPools.size).toBe(0)
    expect(provider.initializeScans.size).toBe(1)
  })
})

describe('UniswapV4Provider Initialize discovery', () => {
  const getLogs = vi.spyOn(client, 'getLogs')
  afterEach(() => (getLogs as any).mockReset())

  const AFTER_SWAP_HOOK = '0x0000000000000000000000000000000000000040'
  const BEFORE_SWAP_HOOK = '0x0000000000000000000000000000000000000080'
  /** the args of an Initialize log of an ETH/USDC pool, its id computed from the key */
  const initialize = (
    fee: number,
    tickSpacing: number,
    hooks: `0x${string}`,
    id?: `0x${string}`,
  ) => {
    const key = {
      currency0: UNISWAP_V4_NATIVE,
      currency1: USDC.address.toLowerCase() as `0x${string}`,
      fee,
      tickSpacing,
      hooks,
    }
    return {
      args: {
        ...key,
        // the log has a checksummed currency, the key is lowercase
        currency1: USDC.address,
        id: id ?? computeUniswapV4PoolId(key),
      },
    }
  }
  /** a provider that scans from block 1000 in pages of 100 blocks, one read at a time */
  const scanner = () => {
    const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
    provider.initializeLogsFromBlock[ChainId.ETHEREUM] = 1000n
    provider.initializeLogsPageSize = 100n
    provider.initializeLogsConcurrency = 1
    return provider
  }

  it('reads the pages up to the block and keeps the supported pools', async () => {
    const provider = scanner()
    const supported = initialize(3000, 50, AFTER_SWAP_HOOK)
    getLogs.mockImplementation((async (args: any) =>
      args.fromBlock === 1100n
        ? [
            supported,
            // a hook that runs before a swap, a dynamic fee, a wrong id
            initialize(3000, 50, BEFORE_SWAP_HOOK),
            initialize(UNISWAP_V4_DYNAMIC_FEE_FLAG, 50, AFTER_SWAP_HOOK),
            initialize(500, 50, AFTER_SWAP_HOOK, `0x${'1'.repeat(64)}`),
          ]
        : []) as any)
    const found = await provider.getPoolsFromLogs(WETH, USDC, 1250n)
    expect(getLogs.mock.calls.map(([a]) => [a!.fromBlock, a!.toBlock])).toEqual(
      [
        [1000n, 1099n],
        [1100n, 1199n],
        [1200n, 1250n],
      ],
    )
    // one read for every currency of the pairs, the native one among them
    const args = (getLogs.mock.calls[0]![0] as any).args
    expect(args.currency0).toEqual(args.currency1)
    expect(args.currency0).toContain(UNISWAP_V4_NATIVE)
    expect(args.currency0).toContain(USDC.address.toLowerCase())
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      id: supported.args.id,
      currency0: UNISWAP_V4_NATIVE,
      currency1: USDC.address.toLowerCase(),
      fee: 3000,
      tickSpacing: 50,
      hooks: AFTER_SWAP_HOOK,
    })
    expect(found[0]!.token0.address).toBe('')
    expect(found[0]!.token1.address).toBe(USDC.address)
    const scan = provider.initializeScans.get(
      `${UNISWAP_V4_NATIVE}:${USDC.address.toLowerCase()}`,
    )!
    expect(scan.through).toBe(1250n)

    // a later scan reads the blocks after the one it reached, the pools stay
    getLogs.mockClear()
    const again = await provider.getPoolsFromLogs(WETH, USDC, 1300n)
    expect(getLogs.mock.calls.map(([a]) => [a!.fromBlock, a!.toBlock])).toEqual(
      [[1251n, 1300n]],
    )
    expect(again).toEqual(found)
    // nothing new to read
    getLogs.mockClear()
    await provider.getPoolsFromLogs(WETH, USDC, 1300n)
    expect(getLogs).not.toHaveBeenCalled()
  })

  it('stops at a failed page and goes on from there at the next scan', async () => {
    const provider = scanner()
    getLogs.mockImplementation((async (args: any) => {
      if (args.fromBlock === 1100n) throw new Error('range too large')
      return []
    }) as any)
    await provider.getPoolsFromLogs(WETH, USDC, 1250n)
    // the failed page stops the reads after it
    expect(getLogs).toHaveBeenCalledTimes(2)
    const key = `${UNISWAP_V4_NATIVE}:${USDC.address.toLowerCase()}`
    expect(provider.initializeScans.get(key)!.through).toBe(1099n)
    getLogs.mockReset()
    getLogs.mockImplementation((async () => []) as any)
    await provider.getPoolsFromLogs(WETH, USDC, 1250n)
    expect(getLogs.mock.calls[0]![0]!.fromBlock).toBe(1100n)
    expect(provider.initializeScans.get(key)!.through).toBe(1250n)
  })

  it('reads the state of the found pools in a fetch, and scans only when discovery is on', async () => {
    const provider = scanner()
    const supported = initialize(3000, 50, AFTER_SWAP_HOOK)
    getLogs.mockImplementation((async () => [supported]) as any)
    multicall.mockImplementation((async (args: any) =>
      args.contracts.map((c: any) => ({
        status: 'success',
        result:
          c.functionName === 'getSlot0'
            ? c.args[0] === supported.args.id
              ? [2n ** 96n, 0, 0, 3000]
              : [0n, 0, 0, 0]
            : c.functionName === 'getLiquidity'
              ? 9n
              : 0n,
      }))) as any)
    // off by default
    await provider.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 1250n,
    })
    expect(getLogs).not.toHaveBeenCalled()
    expect(provider.pools.size).toBe(0)
    provider.discoverPoolsByLogs = true
    await provider.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 1250n,
    })
    expect(getLogs).toHaveBeenCalled()
    const state = provider.pools.get(supported.args.id)!
    expect(state).toMatchObject({ hooks: AFTER_SWAP_HOOK, liquidity: 9n })
    const list = provider.getCurrentPoolList(WETH, USDC) as UniV4PoolCode[]
    expect(list.map((c) => c.poolKey.hooks)).toEqual([AFTER_SWAP_HOOK])
  })

  it('takes a pool the Initialize logs tell out of the null pools', async () => {
    const provider = scanner()
    provider.discoverPoolsByLogs = true
    const supported = initialize(3000, 50, AFTER_SWAP_HOOK)
    provider.nullPools.set(supported.args.id, 5)
    getLogs.mockImplementation((async () => [supported]) as any)
    multicall.mockImplementation((async (args: any) =>
      args.contracts.map(() => ({
        status: 'success',
        result: [0n, 0, 0, 0],
      }))) as any)
    await provider.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 1250n,
    })
    // it was read again, and its zero price counts a first miss
    const read = (multicall.mock.calls[0]![0] as any).contracts.map(
      (c: any) => c.args[0],
    )
    expect(read).toContain(supported.args.id)
    expect(provider.nullPools.get(supported.args.id)).toBe(1)
  })
})

describe('UniswapV4 DataFetcher base provider', () => {
  /** the base without the RainDataFetcher layer */
  class PlainUniswapV4Provider extends PlainUniswapV4BaseProvider {
    constructor() {
      super(
        ChainId.ETHEREUM,
        client,
        { [ChainId.ETHEREUM]: '0x000000000004444c5dc75cb358380d2e3de08a90' },
        { [ChainId.ETHEREUM]: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227' },
      )
    }
    getType() {
      return LiquidityProviders.UniswapV4
    }
    getPoolProviderName() {
      return 'UniswapV4'
    }
  }

  it('reads every pool on each fetch and keeps no null pools', async () => {
    const provider = new PlainUniswapV4Provider()
    multicall.mockImplementation((async (args: any) =>
      args.contracts.map(() => ({
        status: 'success',
        result: [0n, 0, 0, 0],
      }))) as any)
    await provider.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 123n,
    })
    const first = (multicall.mock.calls[0]![0] as any).contracts.length
    multicall.mockClear()
    await provider.fetchPoolsForToken(WETH, USDC, undefined, {
      blockNumber: 124n,
    })
    expect((multicall.mock.calls[0]![0] as any).contracts.length).toBe(first)
    expect('nullPools' in provider).toBe(false)
  })
})

describe('UniV4PoolCode RouteProcessor6 code', () => {
  const provider = new UniswapV4Provider(ChainId.ETHEREUM, client)
  const native = provider.nativeToken()
  const key = {
    currency0: UNISWAP_V4_NATIVE,
    currency1: USDC.address.toLowerCase() as `0x${string}`,
    fee: 500,
    tickSpacing: 10,
    hooks: UNISWAP_V4_ZERO_HOOKS,
  }
  const TO = '0x1111111111111111111111111111111111111111'
  /** the expected code: pool type 6, PoolManager, output token, fee, tick spacing, hooks, direction, empty hook data, receiver */
  const expected = (tokenOut: string, zeroForOne: boolean) =>
    [
      '06',
      provider.getPoolManager().slice(2),
      tokenOut.slice(2).padStart(40, '0'),
      '0001f4',
      '00000a',
      '0'.repeat(40),
      zeroForOne ? '01' : '00',
      '0'.repeat(64),
      TO.slice(2),
    ]
      .join('')
      .toLowerCase()
  const codeOf = (token0: any, token1: any) =>
    new UniV4PoolCode(
      new UniV4Pool(
        ETH_USDC_500,
        provider.getPoolManager(),
        token0,
        token1,
        0.000625,
        UNISWAP_V4_ZERO_HOOKS,
        0,
        5n,
        2n ** 96n,
        [],
      ),
      key,
      LiquidityProviders.UniswapV4,
      'UniswapV4',
    )
  const swapCode = (code: UniV4PoolCode, from: any, to: any) =>
    code
      .getSwapCodeForRouteProcessor6(
        { tokenFrom: from, tokenTo: to } as any,
        {} as any,
        TO,
      )
      .toLowerCase()

  it('codes the PoolKey fee, tick spacing and hooks, the native output as 0x0', () => {
    const code = codeOf(native, USDC)
    expect(swapCode(code, native, USDC)).toBe(expected(USDC.address, true))
    expect(swapCode(code, USDC, native)).toBe(
      expected(`0x${'0'.repeat(40)}`, false),
    )
    // the tines fee is the swap fee, the PoolKey fee stays the lp fee
    expect(code.pool.fee).toBe(0.000625)
  })

  it('tells the direction whatever the address case', () => {
    const lower = { ...USDC, address: USDC.address.toLowerCase() }
    const code = codeOf(lower, native)
    // the leg's token is checksummed, the pool's token lowercase. The
    // direction byte comes before the hook data length and the receiver
    const direction = (code_: string) => code_.slice(-106, -104)
    expect(direction(swapCode(code, USDC, native))).toBe('01')
    expect(direction(swapCode(code, native, USDC))).toBe('00')
  })

  it('names a route leg by its pool code, all V4 pools have the PoolManager address', () => {
    const L = 10n ** 18n
    const pool = new UniV4Pool(
      ETH_USDC_500,
      provider.getPoolManager(),
      native,
      USDC as RToken,
      0.0005,
      UNISWAP_V4_ZERO_HOOKS,
      0,
      L,
      2n ** 96n,
      [
        { index: -887270, DLiquidity: L },
        { index: 887270, DLiquidity: -L },
      ],
    )
    const code = new UniV4PoolCode(
      pool,
      key,
      LiquidityProviders.UniswapV4,
      'UniswapV4',
    )
    const route = Router.findBestRoute(
      new Map([[pool.uniqueID(), code]]),
      ChainId.ETHEREUM,
      Native.onChain(ChainId.ETHEREUM),
      10n ** 15n,
      USDC,
      0,
    )
    expect(route.status).toBe('Success')
    expect(route.legs.map((l: any) => l.poolName)).toEqual([code.poolName])
  })

  it('codes the native token into two pools for RouteProcessor6, the RouteProcessor4 code takes one native pool only', () => {
    const L = 10n ** 18n
    /** a full range native ETH and USDC pool of the given PoolKey fee and tick spacing */
    const codeWith = (fee: number, tickSpacing: number) => {
      const poolKey = { ...key, fee, tickSpacing }
      const edge = Math.floor(887272 / tickSpacing) * tickSpacing
      const pool = new UniV4Pool(
        computeUniswapV4PoolId(poolKey),
        provider.getPoolManager(),
        native,
        USDC as RToken,
        fee / 1_000_000,
        UNISWAP_V4_ZERO_HOOKS,
        0,
        L,
        2n ** 96n,
        [
          { index: -edge, DLiquidity: L },
          { index: edge, DLiquidity: -L },
        ],
      )
      return new UniV4PoolCode(
        pool,
        poolKey,
        LiquidityProviders.UniswapV4,
        'UniswapV4',
      )
    }
    const codes = [codeWith(500, 10), codeWith(3000, 60)]
    const pools = new Map(codes.map((c) => [c.pool.uniqueID(), c]))
    // a trade large against both pools, the route splits it between them
    const route = Router.findBestRoute(
      pools,
      ChainId.ETHEREUM,
      Native.onChain(ChainId.ETHEREUM),
      L / 5n,
      USDC,
      0,
    )
    expect(route.status).toBe('Success')
    expect(route.legs).toHaveLength(2)
    const rp = '0x2222222222222222222222222222222222222222'
    const code = getRouteProcessor6Code(route, rp, TO, pools).toLowerCase()
    // processNative, two pools, then a share and a pool type 6 swap for each
    expect(code.slice(0, 6)).toBe('0x0302')
    expect(code.slice(10, 12)).toBe('06')
    expect(
      code.split(provider.getPoolManager().slice(2).toLowerCase()),
    ).toHaveLength(3)
    expect(() => getRouteProcessor4Code(route, rp, TO, pools)).toThrow(
      'Not 1 output pool for native token: 2',
    )
  })
})
