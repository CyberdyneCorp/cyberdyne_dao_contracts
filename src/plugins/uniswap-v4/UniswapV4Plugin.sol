// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PluginUUPSUpgradeable} from "@aragon/osx-commons-contracts/src/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {IExecutor, Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

import {IUniswapV4Plugin} from "./IUniswapV4Plugin.sol";
import {IUniversalRouter} from "./IUniversalRouter.sol";
import {IPermit2} from "./IPermit2.sol";
import {IV4PositionManager, V4PoolKey, V4Actions} from "./IV4PositionManager.sol";

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
    /// @notice keccak256("MANAGE_POSITIONS_PERMISSION") — gates v4 LP ops on
    ///         `modifyLiquidities`. Shared name with `UniswapV3Plugin` so the
    ///         subgraph can join both surfaces under one role.
    bytes32 public constant MANAGE_POSITIONS_PERMISSION_ID =
        keccak256("MANAGE_POSITIONS_PERMISSION");

    address public override universalRouter;
    address public override permit2;
    address public override poolManager;

    mapping(address => bool) public override allowedToken;
    bool public override allowlistEnforced;

    /// @inheritdoc IUniswapV4Plugin
    uint256 public override swapNonce;

    /// @notice v4-periphery PositionManager. Set at install or via
    ///         `setV4PositionManager`. The v4 LP lifecycle (mint / increase /
    ///         decrease / burn) routes through `modifyLiquidities` on this
    ///         contract; tokens are pulled via Permit2.
    address public override v4PositionManager;

    /// @notice Monotonic counter making each LP-op `IExecutor.execute` callId
    ///         unique. Separate from `swapNonce` so swap + LP histories don't
    ///         alias in the subgraph.
    uint256 public lpNonce;

    // Storage gap for future upgrades (see OZ §upgradeable storage_gaps).
    // Decremented from 44 → 42 for `v4PositionManager` + `lpNonce`.
    uint256[42] private __gap;

    /// @notice Initialize the plugin instance. Called once via the proxy constructor.
    /// @param _dao The DAO that owns this plugin instance.
    /// @param _universalRouter Address of the Uniswap Universal Router on this chain.
    /// @param _permit2 Address of the Permit2 contract.
    /// @param _poolManager Address of the Uniswap V4 PoolManager.
    /// @param _v4PositionManager Address of the v4-periphery PositionManager
    ///        (zero is allowed at install — LP ops just revert until set via
    ///        `setV4PositionManager`).
    /// @param _initialAllowlist Initial set of tokens permitted to be swapped /
    ///        LP'd. Empty = no restriction.
    function initialize(
        IDAO _dao,
        address _universalRouter,
        address _permit2,
        address _poolManager,
        address _v4PositionManager,
        address[] calldata _initialAllowlist
    ) external initializer {
        __PluginUUPSUpgradeable_init(_dao);

        // I-01: the swap path is unusable without these three endpoints, and a
        // governance typo setting one to address(0) would brick it until a
        // corrective vote — reject zero up front. `v4PositionManager` may be
        // zero here only, to install the plugin with LP deferred.
        if (_universalRouter == address(0)) revert ZeroAddress();
        if (_permit2 == address(0)) revert ZeroAddress();
        if (_poolManager == address(0)) revert ZeroAddress();

        universalRouter = _universalRouter;
        permit2 = _permit2;
        poolManager = _poolManager;
        v4PositionManager = _v4PositionManager;

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
    ///      16-local limit otherwise). Returns a length-5 batch in the exact
    ///      order required by TRD §6.1, with explicit post-swap allowance
    ///      cleanup (M-01).
    function _buildSwapActions(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline,
        address tokenIn,
        uint256 amountIn
    ) private view returns (Action[] memory actions) {
        address router = universalRouter;
        address permit2_ = permit2;

        actions = new Action[](5);
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
        // M-01: explicit allowance cleanup so a route that consumes less than
        // `amountIn` (or a max-input payload) leaves NO residual approval the
        // router could spend later. Reset both allowance layers to zero.
        // 4) Permit2-internal allowance (tokenIn, router) → 0.
        actions[3] = Action({
            to: permit2_,
            value: 0,
            data: abi.encodeCall(IPermit2.approve, (tokenIn, router, 0, 0))
        });
        // 5) DAO → Permit2 ERC20 allowance for tokenIn → 0.
        actions[4] = Action({
            to: tokenIn,
            value: 0,
            data: abi.encodeCall(IERC20.approve, (permit2_, 0))
        });
    }

    /// @inheritdoc IUniswapV4Plugin
    function setUniversalRouter(
        address newRouter
    ) external override auth(UPDATE_ROUTER_PERMISSION_ID) {
        if (newRouter == address(0)) revert ZeroAddress(); // I-01
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

    /// @inheritdoc IUniswapV4Plugin
    /// @dev Reuses `UPDATE_ROUTER_PERMISSION` — both router and PositionManager
    ///      updates are migrations of an external Uniswap target; folding them
    ///      under one permission keeps the install grant list compact.
    function setV4PositionManager(
        address newPositionManager
    ) external override auth(UPDATE_ROUTER_PERMISSION_ID) {
        if (newPositionManager == address(0)) revert ZeroAddress(); // I-01
        address previous = v4PositionManager;
        v4PositionManager = newPositionManager;
        emit V4PositionManagerUpdated(previous, newPositionManager);
    }

    /// @inheritdoc IUniswapV4Plugin
    /// @dev Pass-through to `IV4PositionManager.modifyLiquidities` — the v4
    ///      action stream (`unlockData`) is built off-chain by the proposal and
    ///      forwarded verbatim. The plugin shapes the surrounding Action[]:
    ///        for each input currency:
    ///          1. DAO→Permit2: approve `maxIn[i]` (exact)
    ///          2. Permit2→PositionManager: approve `maxIn[i]` until `deadline`
    ///        then:
    ///          3. PositionManager.modifyLiquidities(unlockData, deadline)
    ///        and for each input currency (M-01 — reset BOTH allowance layers):
    ///          4. Permit2→PositionManager: approve 0 (Permit2-internal reset)
    ///          5. DAO→Permit2: approve 0 (ERC20 reset, no residual allowance)
    ///      and after `execute`, asserts each output currency's DAO balance
    ///      delta ≥ `minOut[i]` (revert OutputShortfall otherwise).
    function modifyLiquidities(
        bytes calldata unlockData,
        uint256 deadline,
        address[] calldata inputCurrencies,
        uint256[] calldata maxIn,
        address[] calldata outputCurrencies,
        uint256[] calldata minOut
    ) external override auth(MANAGE_POSITIONS_PERMISSION_ID) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (inputCurrencies.length != maxIn.length) revert LengthMismatch();
        if (outputCurrencies.length != minOut.length) revert LengthMismatch();
        if (v4PositionManager == address(0)) revert PositionManagerUnset();
        _checkAllowlist(inputCurrencies, outputCurrencies);
        _assertMintRecipientIsDao(unlockData);

        // Snapshot output balances before the call — the slippage check.
        uint256[] memory before_ = _snapshotBalances(outputCurrencies);

        // Hoist the action-batch build into its own statement so the calldata
        // args are off the stack before the executor call.
        Action[] memory actions = _buildLpActions(unlockData, deadline, inputCurrencies, maxIn);

        bytes32 callId = keccak256(abi.encodePacked("UNI_V4_LP:", lpNonce));
        unchecked {
            ++lpNonce;
        }
        // allowFailureMap = 0: any sub-action failure reverts everything (no
        // half-finished state, no lingering Permit2 allowance).
        IExecutor(address(dao())).execute(callId, actions, 0);

        // Post-call slippage guard: every output currency must have grown by
        // at least `minOut[i]` on the DAO.
        _enforceOutputs(outputCurrencies, before_, minOut);

        emit LiquidityModified(lpNonce);
    }

    function _checkAllowlist(
        address[] calldata inputCurrencies,
        address[] calldata outputCurrencies
    ) private view {
        if (!allowlistEnforced) return;
        for (uint256 i; i < inputCurrencies.length; ++i) {
            if (!allowedToken[inputCurrencies[i]]) revert TokenNotAllowed(inputCurrencies[i]);
        }
        for (uint256 i; i < outputCurrencies.length; ++i) {
            if (!allowedToken[outputCurrencies[i]]) revert TokenNotAllowed(outputCurrencies[i]);
        }
    }

    function _snapshotBalances(
        address[] calldata currencies
    ) private view returns (uint256[] memory snap) {
        snap = new uint256[](currencies.length);
        address daoAddr = address(dao());
        for (uint256 i; i < currencies.length; ++i) {
            snap[i] = IERC20(currencies[i]).balanceOf(daoAddr);
        }
    }

    function _enforceOutputs(
        address[] calldata currencies,
        uint256[] memory before_,
        uint256[] calldata minOut
    ) private view {
        address daoAddr = address(dao());
        for (uint256 i; i < currencies.length; ++i) {
            uint256 received = IERC20(currencies[i]).balanceOf(daoAddr) - before_[i];
            if (received < minOut[i]) revert OutputShortfall(currencies[i], received, minOut[i]);
        }
    }

    /// @inheritdoc IUniswapV4Plugin
    /// @dev Same preflight as the wrapper (deadline, length match for inputs,
    ///      PositionManager set, input-side allowlist). Output-side checks are
    ///      wrapper-only because the slippage guard requires balance snapshots
    ///      around `dao.execute`.
    function previewModifyLiquiditiesActions(
        bytes calldata unlockData,
        uint256 deadline,
        address[] calldata inputCurrencies,
        uint256[] calldata maxIn
    ) external view override returns (Action[] memory) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (inputCurrencies.length != maxIn.length) revert LengthMismatch();
        if (v4PositionManager == address(0)) revert PositionManagerUnset();
        if (allowlistEnforced) {
            for (uint256 i; i < inputCurrencies.length; ++i) {
                if (!allowedToken[inputCurrencies[i]]) revert TokenNotAllowed(inputCurrencies[i]);
            }
        }
        _assertMintRecipientIsDao(unlockData);
        return _buildLpActions(unlockData, deadline, inputCurrencies, maxIn);
    }

    /// @dev Decodes the v4 action stream and reverts if any `MINT_POSITION`
    ///      action would mint the position NFT to anyone other than the DAO.
    ///      Defense-in-depth: a malicious proposal could otherwise encode
    ///      `owner = stranger` and the pass-through would happily fund a
    ///      stranger's position from the treasury.
    ///
    ///      `unlockData = abi.encode(bytes actionStream, bytes[] params)`. Each
    ///      byte in `actionStream` is one action opcode; `params[i]` is the
    ///      abi-encoded args for action `i`. `MINT_POSITION` params layout:
    ///      `(V4PoolKey poolKey, int24 tickLower, int24 tickUpper,
    ///        uint256 liquidity, uint128 amount0Max, uint128 amount1Max,
    ///        address owner, bytes hookData)`. We only need `owner`.
    function _assertMintRecipientIsDao(bytes calldata unlockData) private view {
        // Decoding the envelope of an empty / too-short payload would itself
        // revert with an opaque AbiDecodingError; surface a clearer reason.
        if (unlockData.length < 64) revert UnlockDataTooShort();
        (bytes memory actionStream, bytes[] memory params) = abi.decode(
            unlockData,
            (bytes, bytes[])
        );
        // params can be empty (action stream is bytes(0)); a no-op stream is harmless.
        uint256 n = actionStream.length < params.length ? actionStream.length : params.length;
        address daoAddr = address(dao());
        for (uint256 i; i < n; ++i) {
            if (uint8(actionStream[i]) != V4Actions.MINT_POSITION) continue;
            // We deliberately decode the full tuple — the type list must match
            // v4-periphery's PositionManager exactly. Unused locals are dropped
            // by the optimizer.
            (, , , , , , address owner, ) = abi.decode(
                params[i],
                (V4PoolKey, int24, int24, uint256, uint128, uint128, address, bytes)
            );
            if (owner != daoAddr) revert MintRecipientMustBeDao(owner, daoAddr);
        }
    }

    /// @dev Pulled out of `modifyLiquidities` to relieve stack pressure (the
    ///      compiler hits the 16-local limit otherwise). Builds the
    ///      `approve → Permit2.approve → PM.modifyLiquidities → approve(0)`
    ///      batch for an arbitrary number of input currencies.
    function _buildLpActions(
        bytes calldata unlockData,
        uint256 deadline,
        address[] calldata inputCurrencies,
        uint256[] calldata maxIn
    ) private view returns (Action[] memory actions) {
        address permit2_ = permit2;
        address pm = v4PositionManager;
        uint256 n = inputCurrencies.length;
        // 2 actions per input (ERC20 approve, Permit2.approve) + 1 modify + 2
        // resets per input (Permit2-internal reset + ERC20 reset) = 4n + 1
        // (M-01: reset BOTH allowance layers, not just the ERC20 one).
        actions = new Action[](4 * n + 1);

        uint256 k;
        for (uint256 i; i < n; ++i) {
            actions[k++] = Action({
                to: inputCurrencies[i],
                value: 0,
                data: abi.encodeCall(IERC20.approve, (permit2_, maxIn[i]))
            });
            actions[k++] = Action({
                to: permit2_,
                value: 0,
                data: abi.encodeCall(
                    IPermit2.approve,
                    (inputCurrencies[i], pm, uint160(maxIn[i]), uint48(deadline))
                )
            });
        }

        actions[k++] = Action({
            to: pm,
            value: 0,
            data: abi.encodeCall(IV4PositionManager.modifyLiquidities, (unlockData, deadline))
        });

        // M-01: cleanup per input currency — reset the Permit2-internal
        // allowance `(currency, positionManager)` AND the DAO→Permit2 ERC20
        // allowance to zero, so a partial-consumption LP op leaves no residual
        // approval on either layer.
        for (uint256 i; i < n; ++i) {
            actions[k++] = Action({
                to: permit2_,
                value: 0,
                data: abi.encodeCall(IPermit2.approve, (inputCurrencies[i], pm, 0, 0))
            });
            actions[k++] = Action({
                to: inputCurrencies[i],
                value: 0,
                data: abi.encodeCall(IERC20.approve, (permit2_, 0))
            });
        }
    }
}
