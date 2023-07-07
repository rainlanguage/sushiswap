import { Token } from '@sushiswap/currency'
import { PoolCode } from '@sushiswap/router'
import { Address, PublicClient } from 'viem'

import { MultiCallAggregator } from './MulticallAggregator'
import { TokenManager } from './TokenManager'
import { FactoryV2, UniV2Extractor } from './UniV2Extractor'
import { FactoryV3, UniV3Extractor } from './UniV3Extractor'

const delay = async (ms: number) => new Promise((res) => setTimeout(res, ms))

export class Extractor {
  extractorV2?: UniV2Extractor
  extractorV3?: UniV3Extractor

  // IMPORTANT: Use different cacheDir for Extractor with the same chainId
  constructor(args: {
    client: PublicClient
    factoriesV2: FactoryV2[]
    factoriesV3: FactoryV3[]
    tickHelperContract: Address
    cacheDir: string
    logDepth: number
    logging?: boolean
  }) {
    const multiCallAggregator = new MultiCallAggregator(args.client)
    const tokenManager = new TokenManager(multiCallAggregator, args.cacheDir, `tokens-${multiCallAggregator.chainId}`)
    if (args.factoriesV2.length > 0)
      this.extractorV2 = new UniV2Extractor(
        args.client,
        args.factoriesV2,
        args.cacheDir,
        args.logDepth,
        args.logging !== undefined ? args.logging : false,
        multiCallAggregator,
        tokenManager
      )
    if (args.factoriesV3.length > 0)
      this.extractorV3 = new UniV3Extractor(
        args.client,
        args.tickHelperContract,
        args.factoriesV3,
        args.cacheDir,
        args.logDepth,
        args.logging !== undefined ? args.logging : false,
        multiCallAggregator,
        tokenManager
      )
  }

  async start(tokensPrefetch: Token[] = []) {
    await Promise.all([this.extractorV2?.start(), this.extractorV3?.start()].filter((e) => e !== undefined))
    this.getPoolCodesForTokens(tokensPrefetch)
  }

  getPoolCodesForTokens(tokens: Token[]): PoolCode[] {
    const pools2 = this.extractorV2 ? this.extractorV2.getPoolsForTokens(tokens).prefetchedPools : []
    const pools3 = this.extractorV3
      ? (this.extractorV3
          .getWatchersForTokens(tokens)
          .prefetchedPools.map((w) => w.getPoolCode())
          .filter((pc) => pc !== undefined) as PoolCode[])
      : []
    return pools2.concat(pools3)
  }

  async getPoolCodesForTokensAsync(tokens: Token[], timeout: number): Promise<PoolCode[]> {
    let pools: PoolCode[] = []

    let promise2
    if (this.extractorV2) {
      const { prefetchedPools, fetchingPools } = this.extractorV2.getPoolsForTokens(tokens)
      pools = prefetchedPools
      if (fetchingPools)
        promise2 = fetchingPools.then(
          (pools) => (pools = pools.concat(pools)),
          () => undefined
        )
    }

    let promise3
    if (this.extractorV3) {
      const { prefetchedPools: prefetchedWatchers, fetchingPools: fetchingWatchers } =
        this.extractorV3.getWatchersForTokens(tokens)
      pools = prefetchedWatchers
        .map((w) => w.getPoolCode())
        .filter((pc) => pc !== undefined)
        .concat(pools) as PoolCode[]
      if (fetchingWatchers)
        promise3 = fetchingWatchers.then(
          (watchers) =>
            watchers
              .map((w) => w.getPoolCode())
              .filter((pc) => pc !== undefined)
              .concat(pools) as PoolCode[],
          () => undefined
        )
    }

    if (promise2 != undefined || promise3 != undefined) {
      const totalPromise = await Promise.all([promise2, promise3].filter((p) => p != undefined))
      await Promise.any([totalPromise, delay(timeout)])
    }
    return pools
  }
}
