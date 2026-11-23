import { type ChildProcess, spawn } from 'node:child_process'
import { expect } from 'chai'
import { erc20Abi } from 'sushi/abi'
import { ChainId } from 'sushi/chain'
import { zeroG } from 'sushi/config'
import { Native, Token, type Type, WNATIVE } from 'sushi/currency'
import {
  LiquidityProviders,
  type PoolCode,
  RainDataFetcher,
  Router,
} from 'sushi/router'
import {
  http,
  type Address,
  type Chain,
  type Hex,
  createPublicClient,
  createTestClient,
  encodeAbiParameters,
  hexToBigInt,
  keccak256,
  numberToHex,
  publicActions,
  toHex,
  walletActions,
  zeroAddress,
  zeroHash,
} from 'viem'

import RouteProcessor6 from '../artifacts/contracts/RouteProcessor6.sol/RouteProcessor6.json' assert {
  type: 'json',
}
import InfinityVaultSyncer from '../artifacts/contracts/mocks/InfinityMocks.sol/InfinityVaultSyncer.json' assert {
  type: 'json',
}
import MockInfinityVault from '../artifacts/contracts/mocks/InfinityMocks.sol/MockInfinityVault.json' assert {
  type: 'json',
}

// A fork of 0G at a pinned block, run by anvil, with the comfy.fun
// PancakeSwap Infinity CL pools. Needs RPC_URL_ZEROG_FORK, an archive node, and anvil on
// the PATH (or ANVIL_BIN)
const FORK_BLOCK = 51_060_000
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 18546)
const USER: Address = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe'
const RPC = process.env['RPC_URL_ZEROG_FORK']

const W0G = WNATIVE[ChainId.ZEROG]
const ZEROG = Native.onChain(ChainId.ZEROG)
const USDZ = new Token({
  chainId: ChainId.ZEROG,
  address: '0xd4d54bd7379e799417563b1bb42426c9bd4ccb2a',
  decimals: 6,
  symbol: 'USDZ',
})
/** the ERC-7201 storage location of a namespace id */
const erc7201 = (id: string) =>
  hexToBigInt(
    keccak256(
      numberToHex(hexToBigInt(keccak256(toHex(id))) - 1n, { size: 32 }),
    ),
  ) & ~0xffn
/** the slot of a balances mapping that is not a plain slot index, by lowercase token address, see setBalance */
const BALANCE_SLOTS: Record<string, bigint> = {
  // the balanceOf mapping is the third field of the M0 YieldToOne storage of USDZ
  [USDZ.address.toLowerCase()]: erc7201('PYUSDX.storage.YieldToOne') + 2n,
}
const IAI = new Token({
  chainId: ChainId.ZEROG,
  address: '0xc77fbd3824cc68e612b26114d176879addc29463',
  decimals: 18,
  symbol: 'iAI',
})
const BLANKET = new Token({
  chainId: ChainId.ZEROG,
  address: '0x77358dEFE26Ac5824969c819d8a65217665B1803',
  decimals: 18,
  symbol: 'BLANKET',
})
// the pools the swaps go through, all of them have liquidity at the fork block
const POOLS = {
  // no hooks, fee 0.05%
  usdz: '0x2ff52fe9a63af1db82052605a6011284c622b58f5b69ad3122f20cafaa1221db',
  // IAIOpeningFeeHook, a dynamic fee the hook sets for each swap
  iai: '0x3b188fd684701c53e6546b0c5009d51722512c02a635ccd25b91d593a3b4829a',
  // ComfyLaunchHook, the hook takes its own charge on each swap
  blanket: '0x53f5e244cfe603a42c3a7cf5b6248fcdf3461ce25384356b150cbc7e53c62299',
  wrap: W0G.address,
}

const createClient = () =>
  createTestClient({
    mode: 'anvil',
    chain: zeroG as Chain,
    transport: http(`http://127.0.0.1:${ANVIL_PORT}`, { timeout: 120_000 }),
  })
    .extend(publicActions)
    .extend(walletActions)

// the rain CI runs the tests of one chain in each job, the chain CHAIN names
const describeOnChain =
  ChainId[process?.env?.CHAIN as keyof typeof ChainId] === ChainId.ZEROG
    ? describe.only
    : describe.skip

describeOnChain('RouteProcessor6 comfy.fun swaps on a 0G fork', () => {
  let anvil: ChildProcess | undefined
  let client: ReturnType<typeof createClient>
  let rp: Address
  let pools: Map<string, PoolCode>
  let snapshot: Hex

  before(async () => {
    if (!RPC) throw new Error('RPC_URL_ZEROG_FORK is not set')
    anvil = spawn(
      process.env.ANVIL_BIN ?? 'anvil',
      [
        '--fork-url',
        RPC,
        '--fork-block-number',
        String(FORK_BLOCK),
        '--port',
        String(ANVIL_PORT),
        '--silent',
      ],
      { stdio: 'ignore' },
    )
    anvil.on('error', (e) => {
      throw e
    })
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
    expect(await client.getCode({ address: USER })).to.equal(undefined)
    await client.impersonateAccount({ address: USER })
    await client.setBalance({ address: USER, value: 10_000n * 10n ** 18n })

    // the pools as RainDataFetcher reads them at the fork block, read from the
    // RPC itself, through anvil every storage slot would be loaded one by one
    const reader = createPublicClient({
      chain: zeroG as Chain,
      transport: http(RPC),
    })
    const fetcher = await RainDataFetcher.init(
      ChainId.ZEROG,
      reader as any,
      [LiquidityProviders.Comfy],
      BigInt(FORK_BLOCK),
    )
    pools = new Map()
    for (const token of [USDZ, IAI, BLANKET]) {
      await fetcher.fetchPoolsForToken(W0G, token, undefined, {
        blockNumber: BigInt(FORK_BLOCK),
      })
      fetcher
        .getCurrentPoolCodeMap(W0G, token)
        .forEach((pc, id) => pools.set(id, pc))
    }

    const hash = await client.deployContract({
      account: USER,
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

  /**
   * Sets an ERC20 balance, the slot of the balances mapping is the one of
   * BALANCE_SLOTS, or it is found by trying the slot indexes
   */
  async function setBalance(token: Token, account: Address, amount: bigint) {
    const address = token.address as Address
    const known = BALANCE_SLOTS[address.toLowerCase()]
    const mappings = [
      ...(known === undefined ? [] : [known]),
      ...Array.from({ length: 100 }, (_, i) => BigInt(i)),
    ]
    for (const mapping of mappings) {
      const slot = keccak256(
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'uint256' }],
          [account, mapping],
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
   * Finds the route through exactly the given pools, swaps it with
   * RouteProcessor6 and checks the amount out. The quote leaves out what a
   * hook takes, so a route through a hook that takes a charge is checked to
   * give something and the share of the quote it gave is told
   * @param exact - the received amount must be the quote
   */
  async function swap(
    ids: string[],
    from: Type,
    to: Type,
    amountIn: bigint,
    exact: boolean,
  ) {
    const picked = pick(ids)
    const route = Router.findBestRoute(
      picked,
      ChainId.ZEROG,
      from,
      amountIn,
      to,
      1e9,
    )
    expect(route.status).to.equal('Success')
    expect(new Set(route.legs.map((l) => l.uniqueId))).to.deep.equal(
      new Set(picked.keys()),
    )

    if (!from.isNative) {
      await setBalance(from, USER, amountIn)
      const approve = await client.writeContract({
        account: USER,
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
      USER,
      rp,
      [],
      // a hook charge is not in the quote
      exact ? 0.005 : 0.5,
    )
    const before = await balanceOf(to, USER)
    const hash = await client.sendTransaction({
      account: USER,
      to: rp,
      data: params.data as Hex,
      value: params.value,
    })
    const receipt = await client.waitForTransactionReceipt({ hash })
    expect(receipt.status).to.equal('success')
    let received = (await balanceOf(to, USER)) - before
    // the user pays the gas in native, it is no part of what the swap gave
    if (to.isNative) received += receipt.gasUsed * receipt.effectiveGasPrice

    expect(received >= params.amountOutMin).to.equal(true)
    expect(received > 0n).to.equal(true)
    if (exact) {
      const diff = received - route.amountOutBI
      expect(
        (diff < 0n ? -diff : diff) * 100_000n <= route.amountOutBI,
      ).to.equal(
        true,
        `received ${received}, the route expects ${route.amountOutBI}`,
      )
    } else {
      const share = Number((received * 1_000_000n) / route.amountOutBI) / 10_000
      console.log(
        `      ${from.symbol} -> ${to.symbol}: received ${share}% of the quote, the rest is the hook charge`,
      )
    }
    // the RP keeps nothing of the swap, at most the 1 wei of an ERC20 it
    // passed on, see processMyERC20, processNative passes on all its native
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
        `the RP keeps ${kept} of ${address || '0G'}`,
      )
    }
    return { route, received }
  }

  it('swaps 0G to USDZ through the pool without hooks', async () => {
    await swap([POOLS.usdz], ZEROG, USDZ, 10n ** 18n, true)
  })

  // the pool has one position around the price, it ends at the next
  // initialized tick above, about 74,715 USDZ away, so a sell stays inside it
  it('swaps USDZ to 0G through the pool without hooks, the sell side of the quote', async () => {
    await swap([POOLS.usdz], USDZ, ZEROG, 10n * 10n ** 6n, true)
  })

  it('swaps 0G to iAI through the pool whose hook sets a dynamic fee', async () => {
    await swap([POOLS.iai], ZEROG, IAI, 10n ** 18n, true)
  })

  it('swaps 0G to BLANKET through the comfy launch hook pool', async () => {
    await swap([POOLS.blanket], ZEROG, BLANKET, 10n ** 18n, false)
  })

  it('swaps BLANKET to 0G through the comfy launch hook pool, the native 0G out paid to the user', async () => {
    await swap([POOLS.blanket], BLANKET, ZEROG, 1_000n * 10n ** 18n, false)
  })

  it('swaps W0G to BLANKET through the unwrap and the comfy launch hook pool', async () => {
    await swap([POOLS.wrap, POOLS.blanket], W0G, BLANKET, 10n ** 18n, false)
  })

  it('swaps BLANKET to iAI through the comfy launch hook pool and the iAI hook pool, the native 0G between them goes through the RP', async () => {
    await swap(
      [POOLS.blanket, POOLS.iai],
      BLANKET,
      IAI,
      1_000n * 10n ** 18n,
      false,
    )
  })

  /** the vault of the comfy pool codes */
  const vaultOf = (ids: string[]) =>
    ([...pick(ids).values()][0] as PoolCode & { vault: Address }).vault

  it('rejects a lockAcquired that is not the vault calling back inside a swap', async () => {
    const vault = vaultOf([POOLS.usdz])
    for (const account of [USER, vault]) {
      let error: unknown
      try {
        await client.simulateContract({
          account,
          address: rp,
          abi: RouteProcessor6.abi,
          functionName: 'lockAcquired',
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

  it('reverts an Infinity CL leg whose vault returns from lock without calling back', async () => {
    const picked = pick([POOLS.usdz])
    const vault = vaultOf([POOLS.usdz])
    // answers every call with an empty bytes and never calls back
    const fake: Address = '0x000000000000000000000000000000000000fa4e'
    await client.setCode({ address: fake, bytecode: '0x602060005260406000f3' })
    const route = Router.findBestRoute(
      picked,
      ChainId.ZEROG,
      ZEROG,
      10n ** 18n,
      USDZ,
      1e9,
    )
    const params = Router.routeProcessor6Params(
      picked,
      route,
      ZEROG,
      USDZ,
      USER,
      rp,
    )
    const data = (params.data as string).replace(
      new RegExp(vault.slice(2), 'i'),
      fake.slice(2),
    ) as Hex
    expect(data).not.to.equal(params.data)
    let error: unknown
    try {
      await client.call({ account: USER, to: rp, data, value: params.value })
    } catch (e) {
      error = e
    }
    expect(String((error as Error | undefined)?.message)).to.contain(
      'Expected UniV4 manager slot error',
    )
  })

  async function deploy(artifact: { abi: any; bytecode: string }) {
    const hash = await client.deployContract({
      account: USER,
      abi: artifact.abi,
      bytecode: artifact.bytecode as Hex,
      args: [],
    })
    return (await client.waitForTransactionReceipt({ hash })).contractAddress!
  }

  /**
   * The route of amountIn of from to to through the 0G and BLANKET pool, with
   * the vault and the pool manager replaced by a new mock that gives the
   * deltas, and with no minimum output, the mock pays out nothing
   * @param deltas - the swap delta and the balance deltas of the RP:
   * [swapAmount0, swapAmount1, delta0, delta1], 0G is currency0
   * @returns the mock, the calldata and the value of the RP call
   */
  async function mockRoute(
    from: Type,
    to: Type,
    amountIn: bigint,
    deltas: [bigint, bigint, bigint, bigint],
  ): Promise<{ mock: Address; data: Hex; value: bigint }> {
    const picked = pick([POOLS.blanket])
    const code = [...picked.values()][0] as PoolCode & { vault: Address }
    const mock = await deploy(MockInfinityVault)
    const set = await client.writeContract({
      account: USER,
      address: mock,
      abi: MockInfinityVault.abi,
      functionName: 'setDeltas',
      args: deltas,
    })
    await client.waitForTransactionReceipt({ hash: set })
    if (!from.isNative) {
      await setBalance(from as Token, USER, amountIn)
      const approve = await client.writeContract({
        account: USER,
        address: from.address as Address,
        abi: erc20Abi,
        functionName: 'approve',
        args: [rp, amountIn],
      })
      await client.waitForTransactionReceipt({ hash: approve })
    }
    const route = Router.findBestRoute(
      picked,
      ChainId.ZEROG,
      from,
      amountIn,
      to,
      1e9,
    )
    const params = Router.routeProcessor6Params(
      picked,
      route,
      from,
      to,
      USER,
      rp,
      [],
      1,
    )
    const data = (params.data as string)
      .replace(new RegExp(code.vault.slice(2), 'i'), mock.slice(2))
      .replace(
        new RegExp(code.pool.address.slice(2), 'i'),
        mock.slice(2),
      ) as Hex
    expect(data).not.to.equal(params.data)
    return { mock, data, value: params.value }
  }

  /**
   * Calls the RP with the route of mockRoute
   * @returns the revert message, undefined when the route went through
   */
  async function swapOnMock(
    from: Type,
    to: Type,
    amountIn: bigint,
    deltas: [bigint, bigint, bigint, bigint],
  ): Promise<string | undefined> {
    const { data, value } = await mockRoute(from, to, amountIn, deltas)
    try {
      await client.call({ account: USER, to: rp, data, value })
    } catch (e) {
      return String((e as Error).message)
    }
    return undefined
  }

  it('settles the full input into a mock vault and takes the output delta to the leg receiver, in both directions', async () => {
    /** sends the route through the mock, and reads what the mock recorded */
    const run = async (
      from: Type,
      to: Type,
      amountIn: bigint,
      deltas: [bigint, bigint, bigint, bigint],
    ) => {
      const { mock, data, value } = await mockRoute(from, to, amountIn, deltas)
      const hash = await client.sendTransaction({
        account: USER,
        to: rp,
        data,
        value,
      })
      const receipt = await client.waitForTransactionReceipt({ hash })
      expect(receipt.status).to.equal('success')
      const read = (functionName: string, args: unknown[] = []) =>
        client.readContract({
          address: mock,
          abi: MockInfinityVault.abi,
          functionName,
          args,
        }) as Promise<any>
      return {
        settled: async (currency: Address) => read('settled', [currency]),
        take: async () =>
          [
            await read('takes'),
            String(await read('takeCurrency')).toLowerCase(),
            String(await read('takeTo')).toLowerCase(),
            await read('takeAmount'),
          ] as const,
      }
    }
    const blanketAddress = BLANKET.address.toLowerCase() as Address
    // 0G in: the native value settles the input, the BLANKET out goes to the user
    const native = 10n ** 18n
    const toBlanket = await run(ZEROG, BLANKET, native, [
      -native,
      5n,
      -native,
      5n,
    ])
    expect(await toBlanket.settled(zeroAddress)).to.equal(native)
    expect(await toBlanket.settled(blanketAddress)).to.equal(0n)
    expect(await toBlanket.take()).to.deep.equal([
      1n,
      blanketAddress,
      USER.toLowerCase(),
      5n,
    ])
    // BLANKET in: the tokens sent since the sync settle the input, the native
    // 0G out goes to the user
    const blanket = 1_000n * 10n ** 18n
    const toNative = await run(BLANKET, ZEROG, blanket, [
      5n,
      -blanket,
      5n,
      -blanket,
    ])
    expect(await toNative.settled(blanketAddress)).to.equal(blanket)
    expect(await toNative.settled(zeroAddress)).to.equal(0n)
    expect(await toNative.take()).to.deep.equal([
      1n,
      zeroAddress,
      USER.toLowerCase(),
      5n,
    ])
  })

  it('reverts a 0G to BLANKET Infinity CL leg on a partial fill, a positive input delta, a swap delta that is not the balance delta and an output debt', async () => {
    const native = 10n ** 18n
    const cases: [[bigint, bigint, bigint, bigint], string][] = [
      [
        [-native / 2n, 5n, -native / 2n, 5n],
        'deltaAfter0 is not equal to data.params.amountSpecified',
      ],
      [
        [1n, 5n, 1n, 5n],
        'deltaAfter0 is not equal to data.params.amountSpecified',
      ],
      [
        [-native + 1n, 5n, -native, 5n],
        'delta.amount0() is not equal to deltaAfter0',
      ],
      [
        [-native, -1n, -native, -1n],
        'deltaAfter1 is not greater than or equal to 0',
      ],
    ]
    for (const [deltas, message] of cases) {
      expect(await swapOnMock(ZEROG, BLANKET, native, deltas)).to.contain(
        message,
      )
    }
  })

  it('reverts a BLANKET to 0G Infinity CL leg on a partial fill, a positive input delta, a swap delta that is not the balance delta and an output debt', async () => {
    const blanket = 1_000n * 10n ** 18n
    const cases: [[bigint, bigint, bigint, bigint], string][] = [
      [
        [5n, -blanket / 2n, 5n, -blanket / 2n],
        'deltaAfter1 is not equal to data.params.amountSpecified',
      ],
      [
        [5n, 1n, 5n, 1n],
        'deltaAfter1 is not equal to data.params.amountSpecified',
      ],
      [
        [5n, -blanket + 1n, 5n, -blanket],
        'delta.amount1() is not equal to deltaAfter1',
      ],
      [
        [-1n, -blanket, -1n, -blanket],
        'deltaAfter0 is not greater than or equal to 0',
      ],
    ]
    for (const [deltas, message] of cases) {
      expect(await swapOnMock(BLANKET, ZEROG, blanket, deltas)).to.contain(
        message,
      )
    }
  })

  it('settles native 0G into the vault after an earlier call of the transaction left an ERC20 synced', async () => {
    const picked = pick([POOLS.usdz])
    const code = [...picked.values()][0] as PoolCode & { vault: Address }
    const syncer = await deploy(InfinityVaultSyncer)
    const route = Router.findBestRoute(
      picked,
      ChainId.ZEROG,
      ZEROG,
      10n ** 18n,
      USDZ,
      1e9,
    )
    const params = Router.routeProcessor6Params(
      picked,
      route,
      ZEROG,
      USDZ,
      USER,
      rp,
    )
    const before = await balanceOf(USDZ, USER)
    // the syncer leaves USDZ synced, then calls the RP in the same transaction
    const hash = await client.writeContract({
      account: USER,
      address: syncer,
      abi: InfinityVaultSyncer.abi,
      functionName: 'syncThenCall',
      args: [code.vault, USDZ.address, rp, params.data],
      value: params.value,
    })
    const receipt = await client.waitForTransactionReceipt({ hash })
    expect(receipt.status).to.equal('success')
    expect(
      (await balanceOf(USDZ, USER)) - before >= params.amountOutMin,
    ).to.equal(true)
  })
})
