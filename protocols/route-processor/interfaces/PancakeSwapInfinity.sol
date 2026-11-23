// SPDX-License-Identifier: UNLICENSED

pragma solidity =0.8.25;

import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {Currency, IHooks, BalanceDelta} from './UniV4.sol';

/// @notice The PoolKey of a PancakeSwap Infinity pool
struct InfinityPoolKey {
  /// @notice The lower currency of the pool, sorted numerically, address(0) for native
  Currency currency0;
  /// @notice The higher currency of the pool, sorted numerically
  Currency currency1;
  /// @notice The hooks of the pool
  IHooks hooks;
  /// @notice The pool manager of the pool
  address poolManager;
  /// @notice The lp fee, or the dynamic fee flag 0x800000
  uint24 fee;
  /// @notice For a CL pool: the hooks permission bitmap in bits 0-15 and the tick spacing in bits 16-39
  bytes32 parameters;
}

/// @notice The swap of a PancakeSwap Infinity CL pool manager
interface IInfinityCLPoolManager {
  struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
  }

  /// @notice Swaps against the given pool, inside a Vault lock
  /// @return delta The balance delta of the caller
  function swap(InfinityPoolKey memory key, SwapParams memory params, bytes calldata hookData)
    external
    returns (BalanceDelta delta);
}

/// @notice The PancakeSwap Infinity Vault calls a swap needs
interface IInfinityVault {
  /// @notice Calls ILockCallback(msg.sender).lockAcquired(data), every delta must be settled when it returns
  function lock(bytes calldata data) external returns (bytes memory result);

  /// @notice The current delta of a settler in the currency
  function currencyDelta(address settler, Currency currency) external view returns (int256);

  /// @notice Pays out what the vault owes the caller
  function take(Currency currency, address to, uint256 amount) external;

  /// @notice Writes the current ERC20 balance of the currency, before tokens are sent to the vault
  function sync(Currency currency) external;

  /// @notice Pays what the caller owes, the tokens sent since sync or the native value
  function settle() external payable returns (uint256 paid);
}

library InfinityVaultLibrary {
  using SafeERC20 for IERC20;

  /// @notice Pays the vault the amount of the currency the caller owes
  function settle(IInfinityVault vault, Currency currency, uint256 amount) internal {
    if (Currency.unwrap(currency) == address(0)) {
      // The synced currency stays for the whole transaction: if an earlier call synced an ERC20 and did not
      // settle it, a settle with value reverts. The native sync clears it
      vault.sync(currency);
      vault.settle{value: amount}();
    } else {
      vault.sync(currency);
      // a token that returns no bool (USDT) must not revert the swap
      IERC20(Currency.unwrap(currency)).safeTransfer(address(vault), amount);
      vault.settle();
    }
  }
}
