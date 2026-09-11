import { Address, PublicClient } from 'viem'
import { ChainId } from '../../chain/index.js'
import { CLTick } from '../../tines/index.js'
import { RainDataFetcherOptions } from '../rain/RainDataFetcher.js'
import { RainV3Pool } from '../rain/UniswapV3Base.js'
import { VelodromeSlipstreamBaseProvider } from '../rain/VelodromeSlipstreamBase.js'
import { LiquidityProviders } from './LiquidityProvider.js'
import { bitmapIndex } from './UniswapV3Base.js'

/**
 * slipstream SugarHelper.getPopulatedTicks(pool, startTick): reads
 * SUGAR_HELPER_BITMAPS consecutive tickBitmap words starting at the word of
 * startTick and returns every initialized tick found in them
 */
const sugarHelperAbi = [
  {
    inputs: [
      { internalType: 'address', name: 'pool', type: 'address' },
      { internalType: 'int24', name: 'startTick', type: 'int24' },
    ],
    name: 'getPopulatedTicks',
    outputs: [
      {
        components: [
          { internalType: 'int24', name: 'tick', type: 'int24' },
          { internalType: 'uint160', name: 'sqrtRatioX96', type: 'uint160' },
          { internalType: 'int128', name: 'liquidityNet', type: 'int128' },
          { internalType: 'uint128', name: 'liquidityGross', type: 'uint128' },
        ],
        internalType: 'struct ISugarHelper.PopulatedTick[]',
        name: 'populatedTicks',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// MAX_BITMAPS constant of the slipstream SugarHelper
const SUGAR_HELPER_BITMAPS = 5

/**
 * Up Exchange v3 on Robinhood Chain, an aerodrome slipstream CL fork.
 *
 * The protocol did not deploy a TickLens, and the uniswap v3 TickLens on the
 * chain cannot decode slipstream's ticks() (it has 2 extra fields). The
 * slipstream SugarHelper's getPopulatedTicks() is used as the lens instead,
 * it covers 5 bitmap words per call
 */
export class UpV3Provider extends VelodromeSlipstreamBaseProvider {
  override DEFAULT_TICK_SPACINGS = [1, 50, 100, 200, 2000, 10, 60] as any
  override tickSpacings: number[] = [...this.DEFAULT_TICK_SPACINGS]
  constructor(chainId: ChainId, web3Client: PublicClient) {
    const factory = {
      [ChainId.ROBINHOOD]: '0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3',
    } as const
    // the slipstream SugarHelper, see getTicksInner()
    const tickLens = {
      [ChainId.ROBINHOOD]: '0x673007798f720EC52D07783Cd79362BF624baeCe',
    } as const
    super(chainId, web3Client, factory, tickLens)
  }
  getType(): LiquidityProviders {
    return LiquidityProviders.UpV3
  }
  getPoolProviderName(): string {
    return 'UpV3'
  }

  /**
   * TickLens replacement built on SugarHelper.getPopulatedTicks(): the
   * requested words of each pool are covered with calls 5 words apart, the
   * returned ticks are then bucketed by word. Words that a call did cover
   * are all recorded, even the ones beyond the request, so their ticks are
   * complete. Words of a failed call are left out so they get fetched again
   * on the next round
   */
  override async getTicksInner(
    existingPools: [RainV3Pool, number[]][],
    options?: RainDataFetcherOptions,
  ): Promise<Map<number, CLTick[]>[] | undefined> {
    const sugarHelper = this.tickLens[
      this.chainId as keyof typeof this.tickLens
    ] as Address
    const MAX_WORD = 32767 // int16 max, the last bitmap word

    // one call per 5 consecutive requested words, per pool
    const callList: {
      address: Address
      abi: typeof sugarHelperAbi
      functionName: 'getPopulatedTicks'
      args: readonly [Address, number]
      index: readonly [number, number] // pool index, start word
    }[] = []
    existingPools.forEach(([pool, words], i) => {
      const sorted = [...new Set(words)].sort((a, b) => a - b)
      let next = -Infinity
      sorted.forEach((word) => {
        if (word < next) return // already covered by the previous call
        callList.push({
          address: sugarHelper,
          abi: sugarHelperAbi,
          functionName: 'getPopulatedTicks',
          // a tick inside the word, the helper starts at that word
          args: [pool.address as Address, word * 256 * pool.tickSpacing],
          index: [i, word],
        })
        next = word + SUGAR_HELPER_BITMAPS
      })
    })

    const poolTicks: Map<number, CLTick[]>[] = existingPools.map(
      () => new Map(),
    )
    if (!callList.length) return poolTicks

    const results = await this.client
      .multicall({
        multicallAddress: this.client.chain?.contracts?.multicall3
          ?.address as Address,
        allowFailure: true,
        contracts: callList,
        blockNumber: options?.blockNumber,
      })
      .catch((e) => {
        console.warn(
          `${this.getLogPrefix()} - INIT: getPopulatedTicks multicall failed, message: ${
            e.message
          }`,
        )
        return undefined
      })
    if (!results) return undefined

    results.forEach((res, k) => {
      const ticks = res?.result
      if (!ticks) return // failed call, its words get retried next round
      const [i, startWord] = callList[k]!.index
      const pool = existingPools[i]![0]
      const wordTicks = poolTicks[i]!
      // every word the call covered is complete, even when empty
      const endWord = Math.min(startWord + SUGAR_HELPER_BITMAPS - 1, MAX_WORD)
      for (let word = startWord; word <= endWord; word++) {
        if (!wordTicks.has(word)) wordTicks.set(word, [])
      }
      ticks.forEach((tick) => {
        wordTicks
          .get(bitmapIndex(tick.tick, pool.tickSpacing))
          ?.push({ index: tick.tick, DLiquidity: tick.liquidityNet })
      })
    })
    poolTicks.forEach((wordTicks) =>
      wordTicks.forEach((ticks) => ticks.sort((a, b) => a.index - b.index)),
    )
    return poolTicks
  }
}
