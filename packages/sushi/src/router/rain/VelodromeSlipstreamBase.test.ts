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
import { beforeEach, describe, expect, it } from 'vitest'
import { ChainId } from '../../chain/constants.js'
import { Token } from '../../currency/index.js'
import { AerodromeSlipstreamProvider } from '../liquidity-providers/AerodromeSlipstream.js'
import { AerodromeSlipstreamV2_1Provider } from '../liquidity-providers/AerodromeSlipstreamV2.js'
import { VelodromeSlipstreamProvider } from '../liquidity-providers/VelodromeSlipstream.js'
import {
  FeeType,
  SlipstreamPool,
  VelodromeSlipstreamBaseProvider,
  ZERO_FEE_INDICATOR,
} from './VelodromeSlipstreamBase.js'
import { SlipstreamDynamicFeeV2EventsAbi } from './VelodromeSlipstreamDynamicFeeBase.js'

// offline tests of the fee module event handling, no rpc calls are made
const client = createPublicClient({ transport: http('http://localhost:1') })
const MODULE = '0x1111111111111111111111111111111111111111' as Address
const POOL = '0x2222222222222222222222222222222222222222' as Address
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

function setup<T extends VelodromeSlipstreamBaseProvider>(
  provider: T,
  opts: { fee: number; feeType?: FeeType; blockNumber?: bigint } = {
    fee: 500,
  },
): T {
  provider.swapFeeModule[provider.chainId] = MODULE
  provider.spacingFeeMap = { 1: 100, 50: 500, 100: 500, 200: 3000, 2000: 10000 }
  provider.feeSpacingMap = { 100: 1, 500: 50, 3000: 200, 10000: 2000 }
  const p = provider as any
  if ('defaultScalingFactor' in p) {
    p.defaultScalingFactor[provider.chainId] = 0n
    p.defaultFeeCap[provider.chainId] = 30000n
  }
  const pool: SlipstreamPool = {
    address: POOL,
    token0: WETH,
    token1: USDC,
    fee: opts.fee,
    tickSpacing: 100,
    feeType: opts.feeType ?? FeeType.Default,
    feeConfig: {
      baseFee: 0,
      feeCap: 0,
      scalingFactor: 0n,
      initialFeeEnabled: false,
      initialFee: 0,
    },
    sqrtPriceX96: 1n,
    activeTick: 0,
    tick: 0,
    ticks: new Map(),
    reserve0: 0n,
    reserve1: 0n,
    liquidity: 0n,
    blockNumber: opts.blockNumber ?? 10n,
  } as any
  provider.pools.set(POOL.toLowerCase(), pool)
  return provider
}

function pool(provider: VelodromeSlipstreamBaseProvider): SlipstreamPool {
  return provider.pools.get(POOL.toLowerCase()) as SlipstreamPool
}

function moduleLog(
  eventName: string,
  args: Record<string, unknown>,
  address: Address = MODULE,
  blockNumber = 20n,
): Log {
  const abi = SlipstreamDynamicFeeV2EventsAbi as any
  // encodeEventTopics turns falsy indexed values (0, 0n) into null
  // wildcard topics, replace them with the encoded zero word
  const topics = encodeEventTopics({ abi, eventName, args } as any).map(
    (topic) => topic ?? (`0x${'0'.repeat(64)}` as Hex),
  )
  // all the fee module events only have indexed params, the factory's
  // PoolCreated is the only one with data
  const data =
    eventName === 'PoolCreated'
      ? encodeAbiParameters(
          [{ type: 'address' }],
          [(args as any).pool as Address],
        )
      : '0x'
  return {
    address,
    topics,
    data,
    blockNumber,
    blockHash: '0x',
    logIndex: 0,
    transactionHash: '0x',
    transactionIndex: 0,
    removed: false,
  } as unknown as Log
}

describe('slipstream custom fee module event handling', () => {
  let provider: AerodromeSlipstreamV2_1Provider
  beforeEach(() => {
    provider = setup(new AerodromeSlipstreamV2_1Provider(ChainId.BASE, client))
  })

  it('CustomFeeSet sets a custom base fee', () => {
    provider.processLog(moduleLog('CustomFeeSet', { pool: POOL, fee: 350 }))
    expect(pool(provider).fee).toBe(350)
    expect(pool(provider).feeType).toBe(FeeType.Dynamic)
    expect(pool(provider).feeConfig.baseFee).toBe(350)
    expect(pool(provider).blockNumber).toBe(20n)
  })

  it('legacy SetCustomFee name is handled like CustomFeeSet', () => {
    provider.processLog(moduleLog('SetCustomFee', { pool: POOL, fee: 350 }))
    expect(pool(provider).fee).toBe(350)
    expect(pool(provider).feeType).toBe(FeeType.Dynamic)
  })

  it('CustomFeeSet with ZERO_FEE_INDICATOR gives a zero fee', () => {
    provider.processLog(
      moduleLog('CustomFeeSet', { pool: POOL, fee: ZERO_FEE_INDICATOR }),
    )
    expect(pool(provider).fee).toBe(0)
    expect(pool(provider).feeType).toBe(FeeType.Zero)
  })

  it('CustomFeeSet back to 0 falls back to the tick spacing fee', () => {
    provider.processLog(moduleLog('CustomFeeSet', { pool: POOL, fee: 350 }))
    provider.processLog(moduleLog('CustomFeeSet', { pool: POOL, fee: 0 }))
    expect(pool(provider).fee).toBe(500)
    expect(pool(provider).feeType).toBe(FeeType.Default)
  })

  it('ignores CustomFeeSet from an unknown address', () => {
    provider.processLog(
      moduleLog(
        'CustomFeeSet',
        { pool: POOL, fee: 350 },
        '0x3333333333333333333333333333333333333333',
      ),
    )
    expect(pool(provider).fee).toBe(500)
  })

  it('ignores stale CustomFeeSet logs', () => {
    provider.processLog(
      moduleLog('CustomFeeSet', { pool: POOL, fee: 350 }, MODULE, 5n),
    )
    expect(pool(provider).fee).toBe(500)
  })

  it('TickSpacingEnabled registers the new spacing fee', () => {
    const factory = provider.factory[ChainId.BASE]!
    provider.processLog(
      moduleLog('TickSpacingEnabled', { tickSpacing: 500, fee: 700 }, factory),
    )
    expect(provider.tickSpacings).toContain(500)
    expect(provider.spacingFeeMap[500]).toBe(700)
    expect(provider.feeSpacingMap[700]).toBe(500)
  })

  it('SwapFeeModuleChanged schedules a fee reset', () => {
    const factory = provider.factory[ChainId.BASE]!
    const newModule = '0x4444444444444444444444444444444444444444'
    provider.processLog(
      moduleLog(
        'SwapFeeModuleChanged',
        { oldFeeModule: MODULE, newFeeModule: newModule },
        factory,
      ),
    )
    expect(provider.swapFeeModule[ChainId.BASE]).toBe(newModule)
    expect(provider.shouldResetFees).toBe(true)
  })

  it('dynamic fee module events are not part of its abi', () => {
    const sigs = (provider.eventsAbi as any[]).map((e) => e.name)
    expect(sigs).not.toContain('ScalingFactorSet')
    expect(sigs).not.toContain('InitialFeeSet')
  })
})

describe('slipstream dynamic fee module event handling', () => {
  let provider: AerodromeSlipstreamProvider
  const isVolatile = () => (provider as any).isVolatile(pool(provider))
  beforeEach(() => {
    provider = setup(new AerodromeSlipstreamProvider(ChainId.BASE, client))
  })

  it('exposes every fee module event to the log filter', () => {
    const names = (provider.eventsAbi as any[]).map((e) => e.name)
    for (const name of [
      'CustomFeeSet',
      'ScalingFactorSet',
      'FeeCapSet',
      'DynamicFeeReset',
      'DefaultScalingFactorSet',
      'DefaultFeeCapSet',
      'SecondsAgoSet',
      'InitialFeeSet',
      'InitialFeeDisabled',
      'SwapFeeModuleChanged',
      'TickSpacingEnabled',
      'PoolCreated',
    ])
      expect(names, name).toContain(name)
  })

  it('CustomFeeSet on a non volatile pool resolves the base fee', () => {
    provider.processLog(moduleLog('CustomFeeSet', { pool: POOL, fee: 350 }))
    expect(pool(provider).fee).toBe(350)
    expect(isVolatile()).toBe(false)
  })

  it('ScalingFactorSet makes the pool volatile and keeps the last fee', () => {
    provider.processLog(moduleLog('FeeCapSet', { pool: POOL, feeCap: 2000 }))
    expect(pool(provider).feeConfig.feeCap).toBe(2000)
    expect(isVolatile()).toBe(false)
    provider.processLog(
      moduleLog('ScalingFactorSet', { pool: POOL, scalingFactor: 3000000n }),
    )
    expect(pool(provider).feeConfig.scalingFactor).toBe(3000000n)
    expect(isVolatile()).toBe(true)
    // fee is left for afterProcessLog's fee() re-read
    expect(pool(provider).fee).toBe(500)
  })

  it('CustomFeeSet on a volatile pool does not overwrite the read fee', () => {
    provider.processLog(moduleLog('FeeCapSet', { pool: POOL, feeCap: 2000 }))
    provider.processLog(
      moduleLog('ScalingFactorSet', { pool: POOL, scalingFactor: 3000000n }),
    )
    pool(provider).fee = 579 // as if read from chain
    provider.processLog(moduleLog('CustomFeeSet', { pool: POOL, fee: 535 }))
    expect(pool(provider).feeConfig.baseFee).toBe(535)
    expect(pool(provider).fee).toBe(579)
  })

  it('DynamicFeeReset makes the pool static again', () => {
    provider.processLog(moduleLog('CustomFeeSet', { pool: POOL, fee: 535 }))
    provider.processLog(moduleLog('FeeCapSet', { pool: POOL, feeCap: 2000 }))
    provider.processLog(
      moduleLog('ScalingFactorSet', { pool: POOL, scalingFactor: 3000000n }),
    )
    provider.processLog(
      moduleLog('InitialFeeSet', { pool: POOL, initialFee: 150 }),
    )
    pool(provider).fee = 579
    provider.processLog(moduleLog('DynamicFeeReset', { pool: POOL }))
    expect(pool(provider).feeConfig).toEqual({
      baseFee: 535,
      feeCap: 0,
      scalingFactor: 0n,
      initialFeeEnabled: false,
      initialFee: 0,
    })
    expect(isVolatile()).toBe(false)
    expect(pool(provider).fee).toBe(535)
  })

  it('InitialFeeSet / InitialFeeDisabled toggle volatility', () => {
    provider.processLog(
      moduleLog('InitialFeeSet', { pool: POOL, initialFee: 150 }),
    )
    expect(pool(provider).feeConfig.initialFeeEnabled).toBe(true)
    expect(pool(provider).feeConfig.initialFee).toBe(150)
    expect(isVolatile()).toBe(true)
    pool(provider).fee = 150
    provider.processLog(moduleLog('InitialFeeDisabled', { pool: POOL }))
    expect(pool(provider).feeConfig.initialFeeEnabled).toBe(false)
    expect(isVolatile()).toBe(false)
    expect(pool(provider).fee).toBe(500)
  })

  it('ZERO_FEE_INDICATOR base fee is never volatile', () => {
    provider.processLog(moduleLog('FeeCapSet', { pool: POOL, feeCap: 2000 }))
    provider.processLog(
      moduleLog('ScalingFactorSet', { pool: POOL, scalingFactor: 3000000n }),
    )
    provider.processLog(
      moduleLog('CustomFeeSet', { pool: POOL, fee: ZERO_FEE_INDICATOR }),
    )
    expect(isVolatile()).toBe(false)
    expect(pool(provider).fee).toBe(0)
  })

  it('DefaultScalingFactorSet makes default pools volatile and back', () => {
    expect(isVolatile()).toBe(false)
    provider.processLog(
      moduleLog('DefaultScalingFactorSet', { defaultScalingFactor: 1000000n }),
    )
    expect(isVolatile()).toBe(true)
    pool(provider).fee = 777
    provider.processLog(
      moduleLog('DefaultScalingFactorSet', { defaultScalingFactor: 0n }),
    )
    expect(isVolatile()).toBe(false)
    expect(pool(provider).fee).toBe(500)
  })

  it('default fee cap bounds the static fee of non volatile pools', () => {
    provider.processLog(moduleLog('CustomFeeSet', { pool: POOL, fee: 25000 }))
    expect(pool(provider).fee).toBe(25000)
    provider.processLog(
      moduleLog('DefaultFeeCapSet', { defaultFeeCap: 10000n }),
    )
    expect(pool(provider).fee).toBe(10000)
    provider.processLog(
      moduleLog('DefaultFeeCapSet', { defaultFeeCap: 30000n }),
    )
    expect(pool(provider).fee).toBe(25000)
  })

  it('pool level fee cap is ignored while the scaling factor is zero', () => {
    provider.processLog(moduleLog('CustomFeeSet', { pool: POOL, fee: 25000 }))
    provider.processLog(moduleLog('FeeCapSet', { pool: POOL, feeCap: 100 }))
    expect(pool(provider).fee).toBe(25000)
  })

  it('SecondsAgoSet is accepted', () => {
    provider.processLog(moduleLog('SecondsAgoSet', { secondsAgo: 300 }))
    expect(pool(provider).fee).toBe(500)
  })
})

describe('slipstream dynamic fee module v1 (optimism)', () => {
  it('has no initial fee events in its abi', () => {
    const provider = new VelodromeSlipstreamProvider(ChainId.OPTIMISM, client)
    const names = (provider.eventsAbi as any[]).map((e) => e.name)
    expect(names).toContain('ScalingFactorSet')
    expect(names).not.toContain('InitialFeeSet')
    expect(names).not.toContain('InitialFeeDisabled')
  })
})
