// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {PluginUUPSUpgradeable} from "@aragon/osx-commons-contracts/src/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";

import {IUniswapV4Plugin} from "./IUniswapV4Plugin.sol";

/// @title UniswapV4Plugin (P1 stub)
/// @notice Vote-gated swap plugin. Implementation lands in P2/P3 — this stub
///         locks the external API + event signatures + permission IDs so the
///         frontend, subgraph, and PluginSetup can be built against it today.
/// @dev All mutators revert `NotImplemented` until P3 ships the real swap logic.
contract UniswapV4Plugin is PluginUUPSUpgradeable, IUniswapV4Plugin {
    bytes32 public constant TRIGGER_SWAP_PERMISSION_ID = keccak256("TRIGGER_SWAP_PERMISSION");
    bytes32 public constant UPDATE_ROUTER_PERMISSION_ID = keccak256("UPDATE_ROUTER_PERMISSION");
    bytes32 public constant MANAGE_ALLOWLIST_PERMISSION_ID = keccak256("MANAGE_ALLOWLIST_PERMISSION");

    address public override universalRouter;
    address public override permit2;
    address public override poolManager;

    mapping(address => bool) public override allowedToken;
    bool public override allowlistEnforced;

    // Storage gap for future upgrades (see OZ §upgradeable storage_gaps).
    uint256[45] private __gap;

    /// @notice Initialize the plugin instance. Called once via the proxy constructor.
    /// @param _dao The DAO that owns this plugin instance.
    /// @param _universalRouter Address of the Uniswap Universal Router on this chain.
    /// @param _permit2 Address of the Permit2 contract.
    /// @param _poolManager Address of the Uniswap V4 PoolManager.
    /// @param _initialAllowlist Initial set of tokens permitted to be swapped. Empty = no restriction.
    function initialize(
        IDAO _dao,
        address _universalRouter,
        address _permit2,
        address _poolManager,
        address[] calldata _initialAllowlist
    ) external initializer {
        __PluginUUPSUpgradeable_init(_dao);

        universalRouter = _universalRouter;
        permit2 = _permit2;
        poolManager = _poolManager;

        if (_initialAllowlist.length > 0) {
            allowlistEnforced = true;
            for (uint256 i; i < _initialAllowlist.length; ++i) {
                allowedToken[_initialAllowlist[i]] = true;
                emit AllowedTokenSet(_initialAllowlist[i], true);
            }
        }
    }

    /// @inheritdoc IUniswapV4Plugin
    function swap(
        bytes calldata, /* commands */
        bytes[] calldata, /* inputs */
        uint256, /* deadline */
        address, /* tokenIn */
        uint256, /* amountIn */
        address, /* tokenOut */
        uint256 /* minAmountOut */
    ) external override auth(TRIGGER_SWAP_PERMISSION_ID) {
        revert NotImplemented();
    }

    /// @inheritdoc IUniswapV4Plugin
    function setUniversalRouter(address newRouter) external override auth(UPDATE_ROUTER_PERMISSION_ID) {
        address previous = universalRouter;
        universalRouter = newRouter;
        emit UniversalRouterUpdated(previous, newRouter);
    }

    /// @inheritdoc IUniswapV4Plugin
    function setAllowedToken(address token, bool allowed) external override auth(MANAGE_ALLOWLIST_PERMISSION_ID) {
        allowedToken[token] = allowed;
        if (allowed && !allowlistEnforced) {
            allowlistEnforced = true;
        }
        emit AllowedTokenSet(token, allowed);
    }
}
