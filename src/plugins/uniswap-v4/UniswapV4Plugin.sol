// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PluginUUPSUpgradeable} from "@aragon/osx-commons-contracts/src/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {IExecutor, Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

import {IUniswapV4Plugin} from "./IUniswapV4Plugin.sol";
import {IUniversalRouter} from "./IUniversalRouter.sol";
import {IPermit2} from "./IPermit2.sol";

/// @title UniswapV4Plugin
/// @notice Vote-gated swap plugin for Aragon OSx DAOs. The DAO is the sole
///         custodian of `tokenIn`/`tokenOut`; the plugin only builds the
///         3-action approve-Permit2 → Permit2-approve-router → router-execute
///         batch and triggers it through `IExecutor.execute`.
/// @dev    All proposal payloads (`commands`, `inputs`) flow through unchanged
///         — the plugin's job is purely to (a) enforce allowlist + deadline +
///         post-swap slippage and (b) shape the action batch. The slippage
///         guard compares the DAO's `tokenOut` balance pre vs. post and
///         reverts the whole batch on shortfall.
contract UniswapV4Plugin is PluginUUPSUpgradeable, IUniswapV4Plugin {
    bytes32 public constant TRIGGER_SWAP_PERMISSION_ID = keccak256("TRIGGER_SWAP_PERMISSION");
    bytes32 public constant UPDATE_ROUTER_PERMISSION_ID = keccak256("UPDATE_ROUTER_PERMISSION");
    bytes32 public constant MANAGE_ALLOWLIST_PERMISSION_ID =
        keccak256("MANAGE_ALLOWLIST_PERMISSION");

    address public override universalRouter;
    address public override permit2;
    address public override poolManager;

    mapping(address => bool) public override allowedToken;
    bool public override allowlistEnforced;

    /// @inheritdoc IUniswapV4Plugin
    uint256 public override swapNonce;

    // Storage gap for future upgrades (see OZ §upgradeable storage_gaps).
    // Decremented from 45 → 44 to account for the `swapNonce` slot.
    uint256[44] private __gap;

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
    /// @dev slither(reentrancy-balance): the balance-before/balance-after delta
    ///      pattern is the slippage guard mandated by TRD §6.1; OSx `DAO.execute`
    ///      is `nonReentrant` (TRD §11) so a re-entry into `swap` during the
    ///      external call is impossible. Even if the router credited extra
    ///      tokenOut during the call, that only helps the DAO — the slippage
    ///      check would still pass against the proposal's `minAmountOut`.
    // slither-disable-next-line reentrancy-balance,reentrancy-events
    function swap(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minAmountOut
    ) external override auth(TRIGGER_SWAP_PERMISSION_ID) {
        if (block.timestamp > deadline) revert DeadlineExpired();

        if (allowlistEnforced) {
            if (!allowedToken[tokenIn]) revert TokenNotAllowed(tokenIn);
            if (!allowedToken[tokenOut]) revert TokenNotAllowed(tokenOut);
        }

        address daoAddr = address(dao());
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(daoAddr);

        Action[] memory actions = _buildSwapActions(commands, inputs, deadline, tokenIn, amountIn);

        // Unique callId per swap so the subgraph can correlate `Executed` →
        // `SwapExecuted` 1:1 even across replays in the same block.
        bytes32 callId = keccak256(abi.encodePacked("UNI_V4_SWAP:", swapNonce));
        unchecked {
            ++swapNonce;
        }

        // allowFailureMap = 0: any sub-action failure reverts the whole batch.
        // This is intentional — a half-finished swap (e.g. approve set, route
        // failed) would leave Permit2 with a non-zero allowance hanging.
        IExecutor(daoAddr).execute(callId, actions, 0);

        uint256 received = IERC20(tokenOut).balanceOf(daoAddr) - balanceBefore;
        if (received < minAmountOut) revert SlippageExceeded(received, minAmountOut);

        emit SwapExecuted(tokenIn, amountIn, tokenOut, received);
    }

    /// @dev Pulled out of `swap` to relieve stack pressure (compiler hits the
    ///      16-local limit otherwise). Returns a length-3 batch in the exact
    ///      order required by TRD §6.1.
    function _buildSwapActions(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline,
        address tokenIn,
        uint256 amountIn
    ) private view returns (Action[] memory actions) {
        address router = universalRouter;
        address permit2_ = permit2;

        actions = new Action[](3);
        // 1) DAO approves Permit2 to pull exactly `amountIn` of tokenIn.
        //    Exact-amount (not max) per TRD §11 — leaves zero leftover after
        //    Permit2 settles into the router and into the pool.
        actions[0] = Action({
            to: tokenIn,
            value: 0,
            data: abi.encodeCall(IERC20.approve, (permit2_, amountIn))
        });
        // 2) Permit2 grants the Universal Router a time-bounded allowance.
        //    `uint160(amountIn)` mirrors Permit2's AllowanceTransfer surface.
        actions[1] = Action({
            to: permit2_,
            value: 0,
            data: abi.encodeCall(
                IPermit2.approve,
                (tokenIn, router, uint160(amountIn), uint48(deadline))
            )
        });
        // 3) Universal Router executes the proposal-supplied commands.
        //    The recipient encoded in `inputs` is the DAO — verified by the
        //    post-swap balance check in the caller.
        //    `IUniversalRouter.execute` is overloaded; encode by signature to
        //    pick the 3-arg variant unambiguously.
        actions[2] = Action({
            to: router,
            value: 0,
            data: abi.encodeWithSignature(
                "execute(bytes,bytes[],uint256)",
                commands,
                inputs,
                deadline
            )
        });
    }

    /// @inheritdoc IUniswapV4Plugin
    function setUniversalRouter(
        address newRouter
    ) external override auth(UPDATE_ROUTER_PERMISSION_ID) {
        address previous = universalRouter;
        universalRouter = newRouter;
        emit UniversalRouterUpdated(previous, newRouter);
    }

    /// @inheritdoc IUniswapV4Plugin
    function setAllowedToken(
        address token,
        bool allowed
    ) external override auth(MANAGE_ALLOWLIST_PERMISSION_ID) {
        allowedToken[token] = allowed;
        if (allowed && !allowlistEnforced) {
            allowlistEnforced = true;
        }
        emit AllowedTokenSet(token, allowed);
    }
}
