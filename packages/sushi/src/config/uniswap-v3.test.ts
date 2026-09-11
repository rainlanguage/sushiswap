import { keccak256 } from '@ethersproject/solidity'
import { describe, expect, it } from 'vitest'

import { defaultAbiCoder } from '@ethersproject/abi'
import { getCreate2Address } from '@ethersproject/address'
import IUniswapV3Pool from '@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json' assert {
  type: 'json',
}
import { ChainId } from '../chain/index.js'
import {
  UNISWAP_V3_FACTORY_ADDRESS,
  UNISWAP_V3_INIT_CODE_HASH,
} from './uniswap-v3.js'

// this _could_ go in constants, except that it would cost every consumer of the sdk the CPU to compute the hash
// and load the JSON.
const COMPUTED_INIT_CODE_HASH = keccak256(['bytes'], [IUniswapV3Pool.bytecode])

describe('constants', () => {
  describe('INIT_CODE_HASH', () => {
    it('matches computed bytecode hash', () => {
      expect(COMPUTED_INIT_CODE_HASH).toEqual(
        UNISWAP_V3_INIT_CODE_HASH[ChainId.ETHEREUM],
      )
    })

    // Robinhood Chain's Uniswap V3 sits behind a non-canonical factory address,
    // so the factory/initCodeHash pair cannot be eyeballed against the other
    // chains. Derive a known live pool address from them instead: WETH/USDG
    // 0.01% at 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca.
    it('derives the known Robinhood Chain WETH/USDG pool address', () => {
      const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
      const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
      const fee = 100

      const salt = keccak256(
        ['bytes'],
        [
          defaultAbiCoder.encode(
            ['address', 'address', 'uint24'],
            [WETH, USDG, fee],
          ),
        ],
      )

      expect(
        getCreate2Address(
          UNISWAP_V3_FACTORY_ADDRESS[ChainId.ROBINHOOD],
          salt,
          UNISWAP_V3_INIT_CODE_HASH[ChainId.ROBINHOOD],
        ),
      ).toEqual('0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca')
    })
  })
})
