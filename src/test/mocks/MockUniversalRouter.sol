// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IUniversalRouter} from "../../plugins/uniswap-v4/IUniversalRouter.sol";

interface IMockPermit2Pull {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// @title MockUniversalRouter — test-only stand-in for Uniswap's Universal Router.
/// @notice Configurable swap: on `execute`, optionally pulls `configuredInputAmount`
///         of `configuredTokenIn` from `configuredFrom` *via Permit2* (mirroring
///         the real settlement path), then transfers `configuredOutputAmount` of
///         `configuredTokenOut` from this contract's pre-funded balance to
///         `configuredRecipient`.
/// @dev    Per-test setters keep the wiring obvious in the call site. The mock
///         deliberately ignores `commands`/`inputs`/`deadline` — the plugin
///         only treats them as opaque bytes, so unit tests don't need to
///         encode real V4 commands to exercise the plugin's logic.
contract MockUniversalRouter is IUniversalRouter {
    address public configuredTokenIn;
    address public configuredTokenOut;
    uint256 public configuredInputAmount;
    uint256 public configuredOutputAmount;
    address public configuredFrom; // address from which to pull tokenIn (typically the DAO)
    address public configuredRecipient; // address to which tokenOut goes (typically the DAO)
    address public permit2; // permit2 address used for the simulated pull
    bool public pullTokenIn; // if true, Permit2.transferFrom is invoked in execute()
    bool public shouldRevert;

    function setPermit2(address p) external {
        permit2 = p;
    }

    /// @notice Configure a swap leg the mock will perform on the next `execute()`.
    function setSwap(
        address tokenIn_,
        uint256 inputAmount_,
        address tokenOut_,
        uint256 outputAmount_,
        address from_,
        address recipient_
    ) external {
        configuredTokenIn = tokenIn_;
        configuredInputAmount = inputAmount_;
        configuredTokenOut = tokenOut_;
        configuredOutputAmount = outputAmount_;
        configuredFrom = from_;
        configuredRecipient = recipient_;
    }

    function setPullTokenIn(bool v) external {
        pullTokenIn = v;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    /// @inheritdoc IUniversalRouter
    function execute(bytes calldata, bytes[] calldata, uint256) external payable override {
        if (shouldRevert) revert("MockUniversalRouter: forced revert");
        _settle();
    }

    /// @inheritdoc IUniversalRouter
    function execute(bytes calldata, bytes[] calldata) external payable override {
        if (shouldRevert) revert("MockUniversalRouter: forced revert");
        _settle();
    }

    function _settle() internal {
        if (pullTokenIn && configuredInputAmount > 0) {
            // Real Universal Router → Permit2 → ERC20 settlement path. The
            // ERC20 allowance lives DAO → Permit2, so we must route through
            // Permit2's `transferFrom`, NOT call ERC20.transferFrom directly.
            IMockPermit2Pull(permit2).transferFrom(
                configuredFrom,
                address(this),
                uint160(configuredInputAmount),
                configuredTokenIn
            );
        }
        if (configuredOutputAmount > 0) {
            IERC20(configuredTokenOut).transfer(configuredRecipient, configuredOutputAmount);
        }
    }
}
