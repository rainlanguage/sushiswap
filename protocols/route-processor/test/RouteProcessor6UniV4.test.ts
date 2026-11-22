import { type ChildProcess, spawn } from 'node:child_process'
import { expect } from 'chai'
import { erc20Abi } from 'sushi/abi'
import { ChainId } from 'sushi/chain'
import { Native, Token, type Type } from 'sushi/currency'
import {
  LiquidityProviders,
  type PoolCode,
  RainDataFetcher,
  Router,
  UNISWAP_V4_NATIVE,
  UNISWAP_V4_ZERO_HOOKS,
  computeUniswapV4PoolId,
} from 'sushi/router'
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  encodeAbiParameters,
  keccak256,
  numberToHex,
  publicActions,
  walletActions,
  zeroAddress,
  zeroHash,
} from 'viem'
import { base } from 'viem/chains'

import RouteProcessor6 from '../artifacts/contracts/RouteProcessor6.sol/RouteProcessor6.json' assert {
  type: 'json',
}

// A fork of Base at a pinned block, run by anvil: hardhat 2.20 cannot fork
// Base, its blocks have no totalDifficulty. Needs RPC_URL_BASE_FORK, an archive node,
// and anvil on the PATH (or ANVIL_BIN)
const FORK_BLOCK = 60_174_000
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 18545)
// a user with no code: the keys of the anvil accounts are public, and on
// Base the first one has an EIP-7702 delegation that sends on the native ETH
// it receives
const USER: Address = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe'

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
const CBBTC = new Token({
  chainId: ChainId.BASE,
  address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  decimals: 8,
  symbol: 'cbBTC',
})
const ETH = Native.onChain(ChainId.BASE)

/** the id of a Uniswap V4 pool of native ETH without hooks */
const v4EthPool = (token: Token, fee: number, tickSpacing: number) =>
  computeUniswapV4PoolId({
    currency0: UNISWAP_V4_NATIVE,
    currency1: token.address.toLowerCase() as Address,
    fee,
    tickSpacing,
    hooks: UNISWAP_V4_ZERO_HOOKS,
  })
// the pools the swaps go through, all of them have liquidity at the fork block
const POOLS = {
  v4EthUsdc005: v4EthPool(USDC, 500, 10),
  v4EthUsdc03: v4EthPool(USDC, 3000, 60),
  v4EthCbbtc005: v4EthPool(CBBTC, 500, 10),
  v3WethUsdc005: '0xd0b53D9277642d899DF5C87A3966A349A798F224',
  v2WethUsdc: '0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C',
  wrap: WETH.address,
}

const createClient = () =>
  createTestClient({
    mode: 'anvil',
    chain: base,
    transport: http(`http://127.0.0.1:${ANVIL_PORT}`, { timeout: 120_000 }),
  })
    .extend(publicActions)
    .extend(walletActions)

// the rain CI runs the tests of one chain in each job, the chain CHAIN names
const describeOnChain =
  ChainId[process?.env?.CHAIN as keyof typeof ChainId] === ChainId.BASE
    ? describe.only
    : describe.skip

describeOnChain('RouteProcessor6 Uniswap V4 swaps on a Base fork', () => {
  let anvil: ChildProcess | undefined
  let client: ReturnType<typeof createClient>
  let user: Address
  let rp: Address
  let pools: Map<string, PoolCode>
  let snapshot: Hex

  before(async () => {
    if (!process.env.RPC_URL_BASE_FORK)
      throw new Error('RPC_URL_BASE_FORK is not set')
    anvil = spawn(
      process.env.ANVIL_BIN ?? 'anvil',
      [
        '--fork-url',
        process.env.RPC_URL_BASE_FORK,
        '--fork-block-number',
        String(FORK_BLOCK),
        '--port',
        String(ANVIL_PORT),
        '--silent',
      ],
      { stdio: 'ignore' },
    )
    client = createClient()
    // anvil takes a moment to start
    for (let i = 0; ; i++) {
      try {
        await client.getChainId()
        break
      } catch (e) {
        if (i > 120) throw e
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    user = USER
    expect(await client.getCode({ address: user })).to.equal(undefined)
    await client.impersonateAccount({ address: user })
    await client.setBalance({ address: user, value: 10_000n * 10n ** 18n })

    // the pools as RainDataFetcher reads them at the fork block, the state the
    // fork starts from. They are read from RPC_URL_BASE_FORK itself, through anvil every
    // storage slot would be loaded one by one
    const reader = createPublicClient({
      chain: base,
      transport: http(process.env.RPC_URL_BASE_FORK),
    })
    const fetcher = await RainDataFetcher.init(
      ChainId.BASE,
      reader as any,
      [
        LiquidityProviders.UniswapV2,
        LiquidityProviders.UniswapV3,
        LiquidityProviders.UniswapV4,
      ],
      BigInt(FORK_BLOCK),
    )
    pools = new Map()
    for (const [a, b] of [
      [WETH, USDC],
      [WETH, CBBTC],
    ] as const) {
      await fetcher.fetchPoolsForToken(a, b, undefined, {
        blockNumber: BigInt(FORK_BLOCK),
      })
      fetcher.getCurrentPoolCodeMap(a, b).forEach((pc, id) => pools.set(id, pc))
    }

    const hash = await client.deployContract({
      account: user,
      abi: RouteProcessor6.abi,
      bytecode: RouteProcessor6.bytecode as Hex,
      args: [zeroAddress, []],
    })
    rp = (await client.waitForTransactionReceipt({ hash })).contractAddress!
    snapshot = await client.snapshot()
  })

  after(() => {
    anvil?.kill()
  })

  // every swap starts from the state its route is found on, anvil drops a
  // snapshot once it reverts to it
  beforeEach(async () => {
    await client.revert({ id: snapshot })
    snapshot = await client.snapshot()
  })

  /** the pool codes of the given pools, by their unique id */
  function pick(ids: string[]): Map<string, PoolCode> {
    const picked = new Map<string, PoolCode>()
    ids.forEach((id) => {
      const entry = [...pools].find(([key]) =>
        key.toLowerCase().startsWith(id.toLowerCase()),
      )
      if (!entry) throw new Error(`no pool ${id} at the fork block`)
      picked.set(entry[0], entry[1])
    })
    return picked
  }

  async function balanceOf(token: Type, account: Address): Promise<bigint> {
    if (token.isNative) return client.getBalance({ address: account })
    return client.readContract({
      address: token.address as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    })
  }

  /** Sets an ERC20 balance, the slot of the balances mapping is found by trying */
  async function setBalance(token: Token, account: Address, amount: bigint) {
    const address = token.address as Address
    for (let i = 0n; i < 100n; i++) {
      const slot = keccak256(
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'uint256' }],
          [account, i],
        ),
      )
      const previous = await client.getStorageAt({ address, slot })
      await client.setStorageAt({
        address,
        index: slot,
        value: numberToHex(amount, { size: 32 }),
      })
      if ((await balanceOf(token, account)) === amount) return
      await client.setStorageAt({
        address,
        index: slot,
        value: previous ?? zeroHash,
      })
    }
    throw new Error(`no balance slot of ${token.symbol}`)
  }

  /**
   * Finds the route through exactly the given pools, checks that it uses all
   * of them, swaps it with RouteProcessor6 and checks the amount out
   */
  async function swap(ids: string[], from: Type, to: Type, amountIn: bigint) {
    const picked = pick(ids)
    const route = Router.findBestRoute(
      picked,
      ChainId.BASE,
      from,
      amountIn,
      to,
      1e9,
    )
    expect(route.status).to.equal('Success')
    expect(route.legs.length).to.equal(picked.size)
    expect(new Set(route.legs.map((l) => l.uniqueId))).to.deep.equal(
      new Set(picked.keys()),
    )

    if (!from.isNative) {
      await setBalance(from, user, amountIn)
      const approve = await client.writeContract({
        account: user,
        address: from.address as Address,
        abi: erc20Abi,
        functionName: 'approve',
        args: [rp, amountIn],
      })
      await client.waitForTransactionReceipt({ hash: approve })
    }

    const params = Router.routeProcessor6Params(
      picked,
      route,
      from,
      to,
      user,
      rp,
    )
    const before = await balanceOf(to, user)
    const hash = await client.sendTransaction({
      account: user,
      to: rp,
      data: params.data as Hex,
      value: params.value,
    })
    const receipt = await client.waitForTransactionReceipt({ hash })
    expect(receipt.status).to.equal('success')
    let received = (await balanceOf(to, user)) - before
    // the user pays the gas in native, it is no part of what the swap gave
    if (to.isNative) received += receipt.gasUsed * receipt.effectiveGasPrice

    expect(received >= params.amountOutMin).to.equal(true)
    // the route was found on the state the swap runs on
    const diff = received - route.amountOutBI
    expect((diff < 0n ? -diff : diff) * 100_000n <= route.amountOutBI).to.equal(
      true,
      `received ${received}, the route expects ${route.amountOutBI}`,
    )
    // the RP keeps nothing of the swap, at most the 1 wei of an ERC20 it
    // passed on, see processMyERC20, processNative passes on all its ETH
    const tokens = new Set(
      route.legs.flatMap((l) => [l.tokenFrom.address, l.tokenTo.address]),
    )
    for (const address of tokens) {
      const kept =
        address === ''
          ? await client.getBalance({ address: rp })
          : await client.readContract({
              address: address as Address,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [rp],
            })
      expect(kept <= (address === '' ? 0n : 1n)).to.equal(
        true,
        `the RP keeps ${kept} of ${address || 'ETH'}`,
      )
    }
    return { route, received, gasUsed: receipt.gasUsed }
  }

  it('swaps ETH to USDC through one Uniswap V4 pool', async () => {
    await swap([POOLS.v4EthUsdc005], ETH, USDC, 10n ** 18n)
  })

  it('swaps USDC to cbBTC through two Uniswap V4 pools, USDC to ETH to cbBTC', async () => {
    await swap(
      [POOLS.v4EthUsdc005, POOLS.v4EthCbbtc005],
      USDC,
      CBBTC,
      3_000_000_000n,
    )
  })

  it('swaps ETH to USDC through two Uniswap V4 pools, a V3 pool and a V2 pool', async () => {
    await swap(
      [
        POOLS.v4EthUsdc005,
        POOLS.v4EthUsdc03,
        POOLS.v3WethUsdc005,
        POOLS.v2WethUsdc,
        POOLS.wrap,
      ],
      ETH,
      USDC,
      200n * 10n ** 18n,
    )
  })

  it('swaps WETH to USDC through the wrap and a native Uniswap V4 pool, WETH unwrapped to ETH first', async () => {
    await swap([POOLS.wrap, POOLS.v4EthUsdc005], WETH, USDC, 10n ** 18n)
  })

  it('swaps USDC to WETH through a native Uniswap V4 pool and the wrap, the ETH out wrapped', async () => {
    await swap([POOLS.v4EthUsdc005, POOLS.wrap], USDC, WETH, 3_000_000_000n)
  })

  it('swaps USDC to ETH through one Uniswap V4 pool, the native ETH out paid to the user', async () => {
    await swap([POOLS.v4EthUsdc005], USDC, ETH, 3_000_000_000n)
  })

  it('rejects an unlockCallback that is not the PoolManager calling back inside a swap', async () => {
    const manager = [...pick([POOLS.v4EthUsdc005]).values()][0]!.pool
      .address as Address
    // a user, and the PoolManager itself outside a swap
    for (const account of [user, manager]) {
      let error: unknown
      try {
        await client.simulateContract({
          account,
          address: rp,
          abi: RouteProcessor6.abi,
          functionName: 'unlockCallback',
          args: ['0x'],
        })
      } catch (e) {
        error = e
      }
      expect(String((error as Error | undefined)?.message)).to.contain(
        'Expected UniV4 manager slot error',
      )
    }
  })

  it('reverts a V4 leg whose manager returns from unlock without calling back', async () => {
    const picked = pick([POOLS.v4EthUsdc005])
    const manager = [...picked.values()][0]!.pool.address
    // answers every call with an empty bytes and never calls back
    const fake: Address = '0x000000000000000000000000000000000000fa4e'
    await client.setCode({ address: fake, bytecode: '0x602060005260406000f3' })
    const route = Router.findBestRoute(
      picked,
      ChainId.BASE,
      ETH,
      10n ** 18n,
      USDC,
      1e9,
    )
    const params = Router.routeProcessor6Params(
      picked,
      route,
      ETH,
      USDC,
      user,
      rp,
    )
    const data = (params.data as string).replace(
      new RegExp(manager.slice(2), 'i'),
      fake.slice(2),
    ) as Hex
    expect(data).not.to.equal(params.data)
    let error: unknown
    try {
      await client.call({ account: user, to: rp, data, value: params.value })
    } catch (e) {
      error = e
    }
    expect(String((error as Error | undefined)?.message)).to.contain(
      'Expected UniV4 manager slot error',
    )
  })
})
