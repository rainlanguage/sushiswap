// SPDX-License-Identifier: UNLICENSED

pragma solidity =0.8.25;

// Test contracts for the Uniswap V4 swap of RouteProcessor6. They do not import interfaces/UniV4.sol, its
// transient storage needs the cancun settings of the hardhat overrides

/// @notice The PoolKey of Uniswap V4, as RouteProcessor6 encodes it
struct MockPoolKey {
  address currency0;
  address currency1;
  uint24 fee;
  int24 tickSpacing;
  address hooks;
}

/// @notice The SwapParams of Uniswap V4, as RouteProcessor6 encodes them
struct MockSwapParams {
  bool zeroForOne;
  int256 amountSpecified;
  uint160 sqrtPriceLimitX96;
}

interface IMockUnlockCallback {
  function unlockCallback(bytes calldata data) external returns (bytes memory);
}

interface IMockPoolManager {
  function unlock(bytes calldata data) external returns (bytes memory);

  function sync(address currency) external;
}

/// @notice A Uniswap V4 PoolManager that gives the deltas a test sets: unlock calls back, a swap returns the
/// swap delta and records the balance deltas of the caller, sync, settle and take do nothing
contract MockPoolManager {
  /// @notice the delta a swap returns
  int128 public swapAmount0;
  int128 public swapAmount1;
  /// @notice the balance deltas a swap records for the caller, in currency0 and currency1
  int256 public delta0;
  int256 public delta1;
  /// @notice the balance deltas by keccak256(caller, currency), the exttload slots of v4-core
  mapping(bytes32 => int256) private deltas;

  function setDeltas(int128 _swapAmount0, int128 _swapAmount1, int256 _delta0, int256 _delta1) external {
    swapAmount0 = _swapAmount0;
    swapAmount1 = _swapAmount1;
    delta0 = _delta0;
    delta1 = _delta1;
  }

  function unlock(bytes calldata data) external returns (bytes memory) {
    return IMockUnlockCallback(msg.sender).unlockCallback(data);
  }

  function swap(MockPoolKey memory key, MockSwapParams memory, bytes calldata) external returns (int256 delta) {
    deltas[keccak256(abi.encode(msg.sender, key.currency0))] = delta0;
    deltas[keccak256(abi.encode(msg.sender, key.currency1))] = delta1;
    int128 amount0 = swapAmount0;
    int128 amount1 = swapAmount1;
    // the BalanceDelta packing of v4-core: amount0 in the upper 128 bits, amount1 in the lower 128 bits
    assembly ("memory-safe") {
      delta := or(shl(128, amount0), and(sub(shl(128, 1), 1), amount1))
    }
  }

  function exttload(bytes32 slot) external view returns (bytes32) {
    return bytes32(uint256(deltas[slot]));
  }

  function sync(address) external {}

  function settle() external payable returns (uint256) {
    return msg.value;
  }

  function take(address, address, uint256) external {}
}

/// @notice Leaves a currency synced on a PoolManager and then makes a call, in one transaction: an unlock with
/// only a sync in it is settled, and the synced currency stays for the rest of the transaction
contract PoolManagerSyncer {
  function syncThenCall(
    address manager,
    address currency,
    address target,
    bytes calldata data
  ) external payable returns (bytes memory) {
    IMockPoolManager(manager).unlock(abi.encode(currency));
    (bool success, bytes memory result) = target.call{value: msg.value}(data);
    if (!success) {
      assembly ("memory-safe") {
        revert(add(result, 32), mload(result))
      }
    }
    return result;
  }

  function unlockCallback(bytes calldata data) external returns (bytes memory) {
    IMockPoolManager(msg.sender).sync(abi.decode(data, (address)));
    return '';
  }
}
