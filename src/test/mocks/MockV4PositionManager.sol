// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IV4PositionManager} from "../../plugins/uniswap-v4/IV4PositionManager.sol";

interface IMockPermit2Pull {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// @title MockV4PositionManager
/// @notice Test-only stand-in for Uniswap v4-periphery PositionManager. The
///         plugin treats `unlockData` as opaque, so the mock ignores its
///         contents and instead lets the test pre-configure how the call
///         should move funds: pull N tokens from a payer via Permit2 (mint /
///         increase legs) and/or push M tokens to a recipient (decrease /
///         collect / burn legs). Mirrors `MockUniversalRouter`'s shape.
contract MockV4PositionManager is IV4PositionManager {
    address public override poolManager;
    address public permit2;
    bool public shouldRevert;

    struct Leg {
        address token;
        uint256 amount;
        address peer; // payer (for pull) or recipient (for push)
        bool pull; // true → Permit2.transferFrom(peer, this, amount, token); false → IERC20.transfer
    }

    Leg[] internal _legs;

    function setPoolManager(address pm) external {
        poolManager = pm;
    }

    function setPermit2(address p) external {
        permit2 = p;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function clearLegs() external {
        delete _legs;
    }

    function addPullLeg(address token, uint256 amount, address payer) external {
        _legs.push(Leg({token: token, amount: amount, peer: payer, pull: true}));
    }

    function addPushLeg(address token, uint256 amount, address recipient) external {
        _legs.push(Leg({token: token, amount: amount, peer: recipient, pull: false}));
    }

    /// @dev Fundable with ETH for native-output legs; also receives native-input
    ///      ETH the plugin attaches as msg.value on `modifyLiquidities`.
    receive() external payable {}

    /// @inheritdoc IV4PositionManager
    function modifyLiquidities(bytes calldata, uint256) external payable override {
        if (shouldRevert) revert("MockV4PositionManager: forced revert");
        uint256 n = _legs.length;
        for (uint256 i; i < n; ++i) {
            Leg storage leg = _legs[i];
            if (leg.pull) {
                // Native-ETH pull arrives as msg.value — nothing to pull. ERC20
                // pull routes through Permit2 like the real PositionManager.
                if (leg.token != address(0)) {
                    IMockPermit2Pull(permit2).transferFrom(
                        leg.peer,
                        address(this),
                        uint160(leg.amount),
                        leg.token
                    );
                }
            } else if (leg.token == address(0)) {
                // Native-ETH push: send ether to the recipient (mock must hold it).
                (bool ok, ) = leg.peer.call{value: leg.amount}("");
                require(ok, "MockV4PositionManager: ETH out failed");
            } else {
                IERC20(leg.token).transfer(leg.peer, leg.amount);
            }
        }
    }
}
