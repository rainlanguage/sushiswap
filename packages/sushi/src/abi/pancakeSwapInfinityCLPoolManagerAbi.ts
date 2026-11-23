export const pancakeSwapInfinityCLPoolManagerAbi_getPoolBitmapInfo = [
  {
    inputs: [
      { internalType: 'PoolId', name: 'id', type: 'bytes32' },
      { internalType: 'int16', name: 'word', type: 'int16' },
    ],
    name: 'getPoolBitmapInfo',
    outputs: [{ internalType: 'uint256', name: 'tickBitmap', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const pancakeSwapInfinityCLPoolManagerAbi_getPoolTickInfo = [
  {
    inputs: [
      { internalType: 'PoolId', name: 'id', type: 'bytes32' },
      { internalType: 'int24', name: 'tick', type: 'int24' },
    ],
    name: 'getPoolTickInfo',
    outputs: [
      {
        components: [
          { internalType: 'uint128', name: 'liquidityGross', type: 'uint128' },
          { internalType: 'int128', name: 'liquidityNet', type: 'int128' },
          {
            internalType: 'uint256',
            name: 'feeGrowthOutside0X128',
            type: 'uint256',
          },
          {
            internalType: 'uint256',
            name: 'feeGrowthOutside1X128',
            type: 'uint256',
          },
        ],
        internalType: 'struct Tick.Info',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const
