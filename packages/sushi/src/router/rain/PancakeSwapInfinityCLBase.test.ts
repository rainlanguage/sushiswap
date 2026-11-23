import '../liquidity-providers/index.js'

import {
  http,
  type Address,
  type Hex,
  type Log,
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  toEventSelector,
} from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChainId } from '../../chain/index.js'
import { Token, WNATIVE } from '../../currency/index.js'
import type { RouteLeg } from '../../tines/index.js'
import { ComfyProvider } from '../liquidity-providers/Comfy.js'
import { LiquidityProviders } from '../liquidity-providers/LiquidityProvider.js'
import {
  UNISWAP_V4_NATIVE,
  type UniswapV4PoolState,
} from '../liquidity-providers/UniswapV4Base.js'
import { PancakeSwapInfinityCLPoolCode } from '../pool-codes/index.js'
import {
  PancakeSwapInfinityCLEventsAbi,
  computePancakeSwapInfinityCLPoolId,
  pancakeSwapInfinityCLParameters,
} from './PancakeSwapInfinityCLBase.js'
import { RainDataFetcherStream } from './RainDataFetcherStream.js'

// offline tests, the multicalls are mocks
const client = createPublicClient({ transport: http('http://localhost:1') })
const multicall = vi.spyOn(client, 'multicall')
afterEach(() => multicall.mockReset())

const POOL_MANAGER: Address = '0xaabd31f24914b48daea998e69683225e289d08b0'
const VAULT: Address = '0x5809c1ff809cfc6fca8518016cdffa8339ba2a3a'
const COMFY_HOOK: Address = '0x809acd73ac30b4e2d2dfd7d35b1fda850dcd4334'
const W0G = WNATIVE[ChainId.ZEROG]
const BLANKET = new Token({
  chainId: ChainId.ZEROG,
  address: '0x77358dEFE26Ac5824969c819d8a65217665B1803',
  decimals: 18,
  symbol: 'BLANKET',
})
// pool ids from the Initialize logs of the 0G CLPoolManager
const BLANKET_ID: Hex =
  '0x53f5e244cfe603a42c3a7cf5b6248fcdf3461ce25384356b150cbc7e53c62299'
const IAI_ID: Hex =
  '0x3b188fd684701c53e6546b0c5009d51722512c02a635ccd25b91d593a3b4829a'
const USDZ_ID: Hex =
  '0x2ff52fe9a63af1db82052605a6011284c622b58f5b69ad3122f20cafaa1221db'

describe('PancakeSwap Infinity CL pool keys', () => {
  it('packs the tick spacing and the hooks bitmap into the parameters', () => {
    expect(pancakeSwapInfinityCLParameters(0xfff, 60)).toBe(
      `0x${'0'.repeat(58)}3c0fff`,
    )
    expect(pancakeSwapInfinityCLParameters(0, 10)).toBe(
      `0x${'0'.repeat(58)}0a0000`,
    )
  })

  it('computes the ids of the comfy pools on 0G, whatever the address case', () => {
    const id = (
      currency1: string,
      hooks: string,
      fee: number,
      tickSpacing: number,
      bitmap: number,
    ) =>
      computePancakeSwapInfinityCLPoolId({
        currency0: UNISWAP_V4_NATIVE,
        currency1: currency1 as Address,
        hooks: hooks as Address,
        poolManager: POOL_MANAGER.toUpperCase().replace('0X', '0x') as Address,
        fee,
        parameters: pancakeSwapInfinityCLParameters(bitmap, tickSpacing),
      })
    expect(id(BLANKET.address, COMFY_HOOK, 0, 60, 0xfff)).toBe(BLANKET_ID)
    expect(
      id(
        '0xc77fbd3824cc68e612b26114d176879addc29463',
        '0xc912324aca9ea0cc34c2615dc53d5a0465bbad30',
        0x800000,
        60,
        0x43,
      ),
    ).toBe(IAI_ID)
    expect(
      id(
        '0xd4d54bd7379e799417563b1bb42426c9bd4ccb2a',
        UNISWAP_V4_NATIVE,
        500,
        10,
        0,
      ),
    ).toBe(USDZ_ID)
  })
})

describe('ComfyProvider', () => {
  it('lists the pools of every hook setup for the pair and its native variant', () => {
    const provider = new ComfyProvider(ChainId.ZEROG, client)
    const pools = provider.getStaticPools(W0G, BLANKET)
    const blanket = pools.find((p) => p.id === BLANKET_ID)!
    expect(blanket).toMatchObject({
      currency0: UNISWAP_V4_NATIVE,
      currency1: BLANKET.address.toLowerCase(),
      hooks: COMFY_HOOK,
      fee: 0,
      tickSpacing: 60,
      parameters: pancakeSwapInfinityCLParameters(0xfff, 60),
    })
    expect(blanket.token0.address).toBe('')
    // the W0G pair is there as well as its native variant
    expect(
      pools.find(
        (p) =>
          p.hooks === COMFY_HOOK &&
          p.currency0 === W0G.address.toLowerCase() &&
          p.currency1 === BLANKET.address.toLowerCase(),
      ),
    ).toBeDefined()
    // each pair of the bases of 0G, each with the comfy hook, the iAI hook
    // and the 4 tiers without hooks
    const count = provider.currencyPairs(W0G, BLANKET).length * 6
    expect(pools).toHaveLength(count)
    expect(new Set(pools.map((p) => p.id)).size).toBe(count)
  })

  it('is only on 0G', () => {
    expect(() => new ComfyProvider(ChainId.ETHEREUM, client)).toThrow()
  })

  it('reads the pools from the pool manager and builds Infinity CL pool codes', async () => {
    const provider = new ComfyProvider(ChainId.ZEROG, client)
    multicall.mockImplementation((async (args: any) => {
      const fn = args.contracts[0]?.functionName
      args.contracts.forEach((c: any) => expect(c.address).toBe(POOL_MANAGER))
      if (fn === 'getSlot0')
        return args.contracts.map((c: any) => ({
          status: 'success',
          result:
            c.args[0] === BLANKET_ID ? [2n ** 96n, 3, 0, 0] : [0n, 0, 0, 0],
        }))
      if (fn === 'getLiquidity')
        return args.contracts.map(() => ({ status: 'success', result: 5n }))
      if (fn === 'getPoolBitmapInfo')
        return args.contracts.map((c: any) => ({
          status: 'success',
          result: c.args[1] === 0 ? 1n << 5n : 0n,
        }))
      if (fn === 'getPoolTickInfo')
        return args.contracts.map(() => ({
          status: 'success',
          result: {
            liquidityGross: 7n,
            liquidityNet: 7n,
            feeGrowthOutside0X128: 0n,
            feeGrowthOutside1X128: 0n,
          },
        }))
      throw new Error(`unexpected read ${fn}`)
    }) as any)
    await provider.fetchPoolsForToken(W0G, BLANKET, undefined, {
      blockNumber: 123n,
    })
    const state = provider.pools.get(BLANKET_ID)!
    expect(state).toMatchObject({ liquidity: 5n, lpFee: 0, blockNumber: 123n })
    // the tick at bit 5 of word 0, spacing 60
    expect(state.ticks.get(0)).toEqual([{ index: 300, DLiquidity: 7n }])
    // the other ids are null pools
    expect(provider.nullPools.size).toBe(
      provider.currencyPairs(W0G, BLANKET).length * 6 - 1,
    )

    const [code] = provider.getCurrentPoolList(W0G, BLANKET)
    expect(code).toBeInstanceOf(PancakeSwapInfinityCLPoolCode)
    const infinity = code as PancakeSwapInfinityCLPoolCode
    expect(infinity.vault).toBe(VAULT)
    expect(infinity.poolKey).toEqual({
      currency0: UNISWAP_V4_NATIVE,
      currency1: BLANKET.address.toLowerCase(),
      hooks: COMFY_HOOK,
      fee: 0,
      parameters: pancakeSwapInfinityCLParameters(0xfff, 60),
    })
    expect(infinity.pool.uniqueID()).toBe(BLANKET_ID + POOL_MANAGER)
    expect(infinity.liquidityProvider).toBe(LiquidityProviders.Comfy)
    expect(infinity.getSwapCodeForRouteProcessor4()).toBe('unsupported')
  })
})

describe('PancakeSwapInfinityCLPoolCode RouteProcessor6 code', () => {
  const provider = new ComfyProvider(ChainId.ZEROG, client)
  /** the state of the BLANKET pool with the words around its price read */
  const blanketState = () =>
    ({
      ...provider
        .getStaticPools(W0G, BLANKET)
        .find((p) => p.id === BLANKET_ID)!,
      sqrtPriceX96: 2n ** 96n,
      tick: 0,
      activeTick: 0,
      liquidity: 5n,
      ticks: new Map([
        [-1, []],
        [0, []],
      ]),
      lpFee: 0,
      protocolFee: 0,
      swapFee: 0,
      blockNumber: 1n,
    }) as UniswapV4PoolState

  it('builds no pool code for a state with no PoolKey parameters', () => {
    expect(provider.poolCodeOf(blanketState())).toBeInstanceOf(
      PancakeSwapInfinityCLPoolCode,
    )
    const state = { ...blanketState(), parameters: undefined }
    expect(provider.poolCodeOf(state as UniswapV4PoolState)).toBeUndefined()
  })

  it('codes the vault, the pool manager, the output token, the PoolKey parts, the direction and the receiver', () => {
    const code = provider.poolCodeOf(
      blanketState(),
    ) as PancakeSwapInfinityCLPoolCode
    const TO = '0x1111111111111111111111111111111111111111'
    const native = code.pool.token0
    const swapCode = (from: any, to: any) =>
      code
        .getSwapCodeForRouteProcessor6(
          { tokenFrom: from, tokenTo: to } as RouteLeg,
          {} as any,
          TO,
        )
        .toLowerCase()
    const expected = (tokenOut: string, zeroForOne: boolean) =>
      [
        '07',
        VAULT.slice(2),
        POOL_MANAGER.slice(2),
        tokenOut.slice(2).padStart(40, '0'),
        '000000',
        `${'0'.repeat(58)}3c0fff`,
        COMFY_HOOK.slice(2),
        zeroForOne ? '01' : '00',
        '0'.repeat(64),
        TO.slice(2),
      ]
        .join('')
        .toLowerCase()
    expect(swapCode(native, BLANKET)).toBe(expected(BLANKET.address, true))
    expect(swapCode(BLANKET, native)).toBe(
      expected(`0x${'0'.repeat(40)}`, false),
    )
  })
})

describe('PancakeSwap Infinity CL logs', () => {
  /** a pool manager log of the given event, its own tx */
  const rawLog = (
    eventName: (typeof PancakeSwapInfinityCLEventsAbi)[number]['name'],
    args: Record<string, unknown>,
    blockNumber: bigint,
  ): Log => {
    const item = PancakeSwapInfinityCLEventsAbi.find(
      (e) => e.name === eventName,
    )!
    const topics = encodeEventTopics({
      abi: [item],
      eventName,
      args,
    } as any) as Hex[]
    const nonIndexed = item.inputs.filter((i) => !('indexed' in i && i.indexed))
    return {
      address: POOL_MANAGER,
      topics,
      data: encodeAbiParameters(
        nonIndexed,
        nonIndexed.map((i) => args[i.name as string]) as any,
      ),
      blockNumber,
      logIndex: 0,
      transactionIndex: 0,
      blockHash: '0x',
      transactionHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
      removed: false,
    } as unknown as Log
  }
  const cached = (provider: ComfyProvider) => {
    const pool = {
      ...provider
        .getStaticPools(W0G, BLANKET)
        .find((p) => p.id === BLANKET_ID)!,
      sqrtPriceX96: 2n ** 96n,
      tick: 0,
      activeTick: 0,
      liquidity: 5n,
      ticks: new Map([
        [-1, []],
        [0, []],
      ]),
      lpFee: 0,
      protocolFee: 1000 | (1000 << 12),
      swapFee: 1000,
      blockNumber: 100n,
    } as UniswapV4PoolState
    provider.pools.set(BLANKET_ID, pool)
    return pool
  }

  it('has the event topics of the comfy pool manager on 0G', () => {
    // the first 3 are the topics of the comfy pool manager logs on 0G, the
    // other 2 the ones of the infinity-core events of the same signatures
    expect(
      PancakeSwapInfinityCLEventsAbi.map((e) => [e.name, toEventSelector(e)]),
    ).toEqual([
      [
        'Initialize',
        '0x426cc62fe6a33a40ba2788c2c87a9c34ee4582b95bc9fa5a7bb7ae70b750b99c',
      ],
      [
        'Swap',
        '0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237',
      ],
      [
        'ModifyLiquidity',
        '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
      ],
      [
        'ProtocolFeeUpdated',
        '0xe9c42593e71f84403b84352cd168d693e2c9fcd1fdbcc3feb21d92b43e6696f9',
      ],
      [
        'DynamicLPFeeUpdated',
        '0x14b2b80e0d62303dc85494859f35a84579160aafbd650180ddf526b1ab547bd6',
      ],
    ])
  })

  it('applies an Infinity Swap, its signature has the protocol fee', () => {
    const provider = new ComfyProvider(ChainId.ZEROG, client)
    const pool = cached(provider)
    provider.processLog(
      rawLog(
        'Swap',
        {
          id: BLANKET_ID,
          sender: POOL_MANAGER,
          amount0: -1n,
          amount1: 1n,
          sqrtPriceX96: 3n * 2n ** 96n,
          liquidity: 9n,
          tick: 120,
          fee: 1000,
          protocolFee: 1000,
        },
        105n,
      ),
    )
    expect(pool).toMatchObject({
      sqrtPriceX96: 3n * 2n ** 96n,
      liquidity: 9n,
      tick: 120,
      activeTick: 120,
      blockNumber: 105n,
    })
  })

  it('takes a DynamicLPFeeUpdated into the lp fee and the swap fee, an older one is skipped', () => {
    const provider = new ComfyProvider(ChainId.ZEROG, client)
    const pool = cached(provider)
    provider.processLog(
      rawLog(
        'DynamicLPFeeUpdated',
        { id: BLANKET_ID, dynamicLPFee: 3000 },
        105n,
      ),
    )
    expect(pool.lpFee).toBe(3000)
    expect(pool.swapFee).toBe(3997)
    provider.processLog(
      rawLog(
        'DynamicLPFeeUpdated',
        { id: BLANKET_ID, dynamicLPFee: 9000 },
        101n,
      ),
    )
    expect(pool.lpFee).toBe(3000)
  })

  it('takes a null pool out of the null pools with its Initialize log', () => {
    const provider = new ComfyProvider(ChainId.ZEROG, client)
    provider.nullPools.set(BLANKET_ID, 2)
    const created = provider.processLog(
      rawLog(
        'Initialize',
        {
          id: BLANKET_ID,
          currency0: UNISWAP_V4_NATIVE,
          currency1: BLANKET.address,
          hooks: COMFY_HOOK,
          fee: 0,
          parameters: pancakeSwapInfinityCLParameters(0xfff, 60),
          sqrtPriceX96: 2n ** 96n,
          tick: 0,
        },
        105n,
      ),
    )
    expect(created).toBe(true)
    expect(provider.nullPools.has(BLANKET_ID)).toBe(false)
  })

  it('reads its pool logs by id with the Infinity update topics, the Initialize comes with the factory logs', () => {
    const provider = new ComfyProvider(ChainId.ZEROG, client)
    expect(provider.updateTopics).toHaveLength(4)
    expect(provider.eventsAbi).toEqual([PancakeSwapInfinityCLEventsAbi[0]])
  })
})

describe('RainDataFetcherStream and Infinity CL providers', () => {
  it('takes the comfy provider into the stream, its pool manager is a factory with its Initialize event', async () => {
    const stream = await RainDataFetcherStream.init(
      ChainId.ZEROG,
      client,
      [LiquidityProviders.Comfy],
      1n,
    )
    expect(stream.providers.some((p) => p instanceof ComfyProvider)).toBe(true)
    expect(stream.v4Providers.map((p) => p.getType())).toEqual([
      LiquidityProviders.Comfy,
    ])
    expect(stream.poolManagers).toEqual([POOL_MANAGER])
    expect(stream.factories).toEqual([POOL_MANAGER])
    expect(stream.eventsAbi).toEqual([PancakeSwapInfinityCLEventsAbi[0]])
  })
})
