// SPDX-License-Identifier: UNLICENSED

pragma solidity =0.8.25;

// Test contracts for the PancakeSwap Infinity CL swap of RouteProcessor6. They do not import
// interfaces/PancakeSwapInfinity.sol, it imports interfaces/UniV4.sol, whose transient storage needs the cancun
// settings of the hardhat overrides

/// @notice The PoolKey of PancakeSwap Infinity, as RouteProcessor6 encodes it
struct MockInfinityPoolKey {
  address currency0;
  address currency1;
  address hooks;
  address poolManager;
  uint24 fee;
  bytes32 parameters;
}

/// @notice The SwapParams of an Infinity CL pool manager, as RouteProcessor6 encodes them
struct MockInfinitySwapParams {
  bool zeroForOne;
  int256 amountSpecified;
  uint160 sqrtPriceLimitX96;
}

interface IMockLockCallback {
  function lockAcquired(bytes calldata data) external returns (bytes memory);
}

interface IMockInfinityVault {
  function lock(bytes calldata data) external returns (bytes memory);

  function sync(address currency) external;
}

interface IMockERC20 {
  function balanceOf(address account) external view returns (uint256);
}

/// @notice An Infinity vault and CL pool manager in one that gives the deltas a test sets: lock calls back, a
/// swap returns the swap delta and records the balance deltas of the caller. Sync, settle and take move no
/// tokens, they record what is paid and taken: a settle pays the native value, or the ERC20 tokens sent since sync
contract MockInfinityVault {
  /// @notice the delta a swap returns
  int128 public swapAmount0;
  int128 public swapAmount1;
  /// @notice the balance deltas a swap records for the caller, in currency0 and currency1
  int256 public delta0;
  int256 public delta1;
  /// @notice the balance deltas by settler and currency
  mapping(address => mapping(address => int256)) private deltas;
  /// @notice the currency of the last sync and its balance then, the native currency is address(0)
  address private syncedCurrency;
  uint256 private syncedBalance;
  /// @notice the amounts the callers paid, by currency
  mapping(address => uint256) public settled;
  /// @notice the last take and the number of takes
  address public takeCurrency;
  address public takeTo;
  uint256 public takeAmount;
  uint256 public takes;

  function setDeltas(int128 _swapAmount0, int128 _swapAmount1, int256 _delta0, int256 _delta1) external {
    swapAmount0 = _swapAmount0;
    swapAmount1 = _swapAmount1;
    delta0 = _delta0;
    delta1 = _delta1;
  }

  function lock(bytes calldata data) external returns (bytes memory) {
    return IMockLockCallback(msg.sender).lockAcquired(data);
  }

  function swap(
    MockInfinityPoolKey memory key,
    MockInfinitySwapParams memory,
    bytes calldata
  ) external returns (int256 delta) {
    deltas[msg.sender][key.currency0] = delta0;
    deltas[msg.sender][key.currency1] = delta1;
    int128 amount0 = swapAmount0;
    int128 amount1 = swapAmount1;
    // the BalanceDelta packing: amount0 in the upper 128 bits, amount1 in the lower 128 bits
    assembly ("memory-safe") {
      delta := or(shl(128, amount0), and(sub(shl(128, 1), 1), amount1))
    }
  }

  function currencyDelta(address settler, address currency) external view returns (int256) {
    return deltas[settler][currency];
  }

  function sync(address currency) external {
    syncedCurrency = currency;
    syncedBalance = currency == address(0) ? 0 : IMockERC20(currency).balanceOf(address(this));
  }

  function settle() external payable returns (uint256 paid) {
    address currency = syncedCurrency;
    paid = currency == address(0) ? msg.value : IMockERC20(currency).balanceOf(address(this)) - syncedBalance;
    settled[currency] += paid;
    syncedCurrency = address(0);
  }

  function take(address currency, address to, uint256 amount) external {
    takeCurrency = currency;
    takeTo = to;
    takeAmount = amount;
    takes += 1;
  }
}

/// @notice Leaves a currency synced on an Infinity vault and then makes a call, in one transaction: a lock with
/// only a sync in it is settled, and the synced currency stays for the rest of the transaction
contract InfinityVaultSyncer {
  function syncThenCall(
    address vault,
    address currency,
    address target,
    bytes calldata data
  ) external payable returns (bytes memory) {
    IMockInfinityVault(vault).lock(abi.encode(currency));
    (bool success, bytes memory result) = target.call{value: msg.value}(data);
    if (!success) {
      assembly ("memory-safe") {
        revert(add(result, 32), mload(result))
      }
    }
    return result;
  }

  function lockAcquired(bytes calldata data) external returns (bytes memory) {
    IMockInfinityVault(msg.sender).sync(abi.decode(data, (address)));
    return '';
  }
}
