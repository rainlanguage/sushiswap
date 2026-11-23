export const uniswapV4StateViewAbi_getSlot0 = [
  {
    inputs: [{ internalType: 'PoolId', name: 'poolId', type: 'bytes32' }],
    name: 'getSlot0',
    outputs: [
      { internalType: 'uint160', name: 'sqrtPriceX96', type: 'uint160' },
      { internalType: 'int24', name: 'tick', type: 'int24' },
      { internalType: 'uint24', name: 'protocolFee', type: 'uint24' },
      { internalType: 'uint24', name: 'lpFee', type: 'uint24' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const uniswapV4StateViewAbi_getLiquidity = [
  {
    inputs: [{ internalType: 'PoolId', name: 'poolId', type: 'bytes32' }],
    name: 'getLiquidity',
    outputs: [{ internalType: 'uint128', name: 'liquidity', type: 'uint128' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const uniswapV4StateViewAbi_getTickBitmap = [
  {
    inputs: [
      { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
      { internalType: 'int16', name: 'tick', type: 'int16' },
    ],
    name: 'getTickBitmap',
    outputs: [{ internalType: 'uint256', name: 'tickBitmap', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const uniswapV4StateViewAbi_getTickLiquidity = [
  {
    inputs: [
      { internalType: 'PoolId', name: 'poolId', type: 'bytes32' },
      { internalType: 'int24', name: 'tick', type: 'int24' },
    ],
    name: 'getTickLiquidity',
    outputs: [
      { internalType: 'uint128', name: 'liquidityGross', type: 'uint128' },
      { internalType: 'int128', name: 'liquidityNet', type: 'int128' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const
