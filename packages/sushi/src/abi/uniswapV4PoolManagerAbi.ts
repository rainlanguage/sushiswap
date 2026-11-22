export const uniswapV4PoolManagerAbi_Initialize = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'PoolId', name: 'id', type: 'bytes32' },
      {
        indexed: true,
        internalType: 'Currency',
        name: 'currency0',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'Currency',
        name: 'currency1',
        type: 'address',
      },
      { indexed: false, internalType: 'uint24', name: 'fee', type: 'uint24' },
      {
        indexed: false,
        internalType: 'int24',
        name: 'tickSpacing',
        type: 'int24',
      },
      {
        indexed: false,
        internalType: 'contract IHooks',
        name: 'hooks',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint160',
        name: 'sqrtPriceX96',
        type: 'uint160',
      },
      { indexed: false, internalType: 'int24', name: 'tick', type: 'int24' },
    ],
    name: 'Initialize',
    type: 'event',
  },
] as const
