// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PluginUUPSUpgradeable} from "@aragon/osx-commons-contracts/src/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {IExecutor, Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

import {IUniswapV3Plugin} from "./IUniswapV3Plugin.sol";
import {INonfungiblePositionManager as INPM} from "./INonfungiblePositionManager.sol";

/// @title UniswapV3Plugin
/// @notice Vote-gated management of the DAO's Uniswap V3 liquidity positions —
///         mint / increase / decrease / collect / burn — via the
///         NonfungiblePositionManager (NPM).
/// @dev    Calldata-builder + no-custody model (same as AaveLendingPlugin): the
///         plugin builds an `Action[]` and the DAO executes it, so `msg.sender`
///         at the NPM is the DAO. Positions are minted with `recipient = dao()`,
///         so the NFT — and the authority to manage it — always belong to the
///         DAO. The plugin never holds tokens or NFTs.
///
///         `mint`/`increaseLiquidity` pull tokens from the DAO, so each batch
///         is `approve(amount) → op → approve(0)` (exact-amount approvals, reset
///         to zero so no allowance lingers). `decreaseLiquidity`/`collect`/
///         `burn` move nothing in and need no approvals; `collect`'s recipient
///         is forced to the DAO.
contract UniswapV3Plugin is PluginUUPSUpgradeable, IUniswapV3Plugin {
    bytes32 public constant MANAGE_POSITIONS_PERMISSION_ID =
        keccak256("MANAGE_POSITIONS_PERMISSION");
    bytes32 public constant UPDATE_POSITION_MANAGER_PERMISSION_ID =
        keccak256("UPDATE_POSITION_MANAGER_PERMISSION");
    bytes32 public constant MANAGE_ALLOWLIST_PERMISSION_ID =
        keccak256("MANAGE_ALLOWLIST_PERMISSION");

    address public override positionManager;
    mapping(address => bool) public override allowedToken;
    bool public override allowlistEnforced;

    /// @notice Strictly-increasing counter making each `IExecutor.execute`
    ///         callId unique (subgraph correlation).
    uint256 private _opNonce;

    uint256[46] private __gap;

    /// @notice Initialize the plugin. Called once via the UUPS proxy constructor.
    /// @param _dao              DAO that authorizes this plugin and owns positions.
    /// @param _positionManager  Uniswap V3 NonfungiblePositionManager.
    /// @param _initialAllowlist If non-empty, seeds the token allowlist and
    ///                          flips `allowlistEnforced = true`.
    function initialize(
        IDAO _dao,
        address _positionManager,
        address[] calldata _initialAllowlist
    ) external initializer {
        __PluginUUPSUpgradeable_init(_dao);
        if (_positionManager == address(0)) revert ZeroAddress();
        positionManager = _positionManager;

        if (_initialAllowlist.length > 0) {
            allowlistEnforced = true;
            for (uint256 i; i < _initialAllowlist.length; ++i) {
                allowedToken[_initialAllowlist[i]] = true;
                emit AllowedTokenSet(_initialAllowlist[i], true);
            }
        }
    }

    // --- Action-builder views (governance path) ----------------------------

    /// @inheritdoc IUniswapV3Plugin
    /// @dev Returned `Action[]` is what the wrapper executes via `dao.execute`.
    ///      Same checks as the wrapper (deadline, allowlist) so building a
    ///      proposal whose execution would revert fails at build time.
    function previewMintActions(
        MintParams calldata p
    ) public view override returns (Action[] memory actions) {
        if (block.timestamp > p.deadline) revert DeadlineExpired();
        _checkAllowed(p.token0);
        _checkAllowed(p.token1);

        address npm = positionManager;
        address daoAddr = address(dao());

        actions = new Action[](5);
        actions[0] = _approve(p.token0, npm, p.amount0Desired);
        actions[1] = _approve(p.token1, npm, p.amount1Desired);
        actions[2] = Action({
            to: npm,
            value: 0,
            data: abi.encodeCall(
                INPM.mint,
                (
                    INPM.MintParams({
                        token0: p.token0,
                        token1: p.token1,
                        fee: p.fee,
                        tickLower: p.tickLower,
                        tickUpper: p.tickUpper,
                        amount0Desired: p.amount0Desired,
                        amount1Desired: p.amount1Desired,
                        amount0Min: p.amount0Min,
                        amount1Min: p.amount1Min,
                        recipient: daoAddr,
                        deadline: p.deadline
                    })
                )
            )
        });
        actions[3] = _approve(p.token0, npm, 0);
        actions[4] = _approve(p.token1, npm, 0);
    }

    /// @inheritdoc IUniswapV3Plugin
    function previewIncreaseLiquidityActions(
        uint256 tokenId,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) public view override returns (Action[] memory actions) {
        if (block.timestamp > deadline) revert DeadlineExpired();

        address npm = positionManager;
        (, , address token0, address token1, , , , , , , , ) = INPM(npm).positions(tokenId);
        _checkAllowed(token0);
        _checkAllowed(token1);

        actions = new Action[](5);
        actions[0] = _approve(token0, npm, amount0Desired);
        actions[1] = _approve(token1, npm, amount1Desired);
        actions[2] = Action({
            to: npm,
            value: 0,
            data: abi.encodeCall(
                INPM.increaseLiquidity,
                (
                    INPM.IncreaseLiquidityParams({
                        tokenId: tokenId,
                        amount0Desired: amount0Desired,
                        amount1Desired: amount1Desired,
                        amount0Min: amount0Min,
                        amount1Min: amount1Min,
                        deadline: deadline
                    })
                )
            )
        });
        actions[3] = _approve(token0, npm, 0);
        actions[4] = _approve(token1, npm, 0);
    }

    /// @inheritdoc IUniswapV3Plugin
    function previewDecreaseLiquidityActions(
        uint256 tokenId,
        uint128 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) public view override returns (Action[] memory actions) {
        if (block.timestamp > deadline) revert DeadlineExpired();

        actions = new Action[](1);
        actions[0] = Action({
            to: positionManager,
            value: 0,
            data: abi.encodeCall(
                INPM.decreaseLiquidity,
                (
                    INPM.DecreaseLiquidityParams({
                        tokenId: tokenId,
                        liquidity: liquidity,
                        amount0Min: amount0Min,
                        amount1Min: amount1Min,
                        deadline: deadline
                    })
                )
            )
        });
    }

    /// @inheritdoc IUniswapV3Plugin
    /// @dev `recipient` is forced to the DAO so collected tokens land in the
    ///      treasury, never elsewhere.
    function previewCollectActions(
        uint256 tokenId,
        uint128 amount0Max,
        uint128 amount1Max
    ) public view override returns (Action[] memory actions) {
        actions = new Action[](1);
        actions[0] = Action({
            to: positionManager,
            value: 0,
            data: abi.encodeCall(
                INPM.collect,
                (
                    INPM.CollectParams({
                        tokenId: tokenId,
                        recipient: address(dao()),
                        amount0Max: amount0Max,
                        amount1Max: amount1Max
                    })
                )
            )
        });
    }

    /// @inheritdoc IUniswapV3Plugin
    function previewBurnActions(
        uint256 tokenId
    ) public view override returns (Action[] memory actions) {
        actions = new Action[](1);
        actions[0] = Action({
            to: positionManager,
            value: 0,
            data: abi.encodeCall(INPM.burn, (tokenId))
        });
    }

    // --- Vote-gated operations (direct-call entrypoints) -------------------
    //
    // Each direct entry is a thin wrapper around the matching `preview…`:
    //    actions = preview…(args); dao.execute(actions); emit plugin event.
    // The wrapper is `auth(MANAGE_POSITIONS_PERMISSION)` for direct callers
    // (admin / multisig). Governance proposals bypass the wrapper and submit
    // the action[] returned by `preview…` directly — this avoids the nested
    // `dao.execute` reentrancy that `nonReentrant` on OSx DAO.execute blocks
    // when TokenVoting executes the proposal.

    /// @inheritdoc IUniswapV3Plugin
    function mint(MintParams calldata p) external override auth(MANAGE_POSITIONS_PERMISSION_ID) {
        Action[] memory actions = previewMintActions(p);
        (bytes[] memory results, ) = IExecutor(address(dao())).execute(
            _nextCallId("UNI_V3_MINT:"),
            actions,
            0
        );
        (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) = abi.decode(
            results[2],
            (uint256, uint128, uint256, uint256)
        );
        emit PositionMinted(tokenId, p.token0, p.token1, p.fee, liquidity, amount0, amount1);
    }

    /// @inheritdoc IUniswapV3Plugin
    function increaseLiquidity(
        uint256 tokenId,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external override auth(MANAGE_POSITIONS_PERMISSION_ID) {
        Action[] memory actions = previewIncreaseLiquidityActions(
            tokenId,
            amount0Desired,
            amount1Desired,
            amount0Min,
            amount1Min,
            deadline
        );
        (bytes[] memory results, ) = IExecutor(address(dao())).execute(
            _nextCallId("UNI_V3_INCREASE:"),
            actions,
            0
        );
        (uint128 liquidity, uint256 amount0, uint256 amount1) = abi.decode(
            results[2],
            (uint128, uint256, uint256)
        );
        emit LiquidityIncreased(tokenId, liquidity, amount0, amount1);
    }

    /// @inheritdoc IUniswapV3Plugin
    /// @dev Removes liquidity; the freed tokens accrue as `tokensOwed` on the
    ///      position and are pulled to the DAO via a subsequent `collect`.
    function decreaseLiquidity(
        uint256 tokenId,
        uint128 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external override auth(MANAGE_POSITIONS_PERMISSION_ID) {
        Action[] memory actions = previewDecreaseLiquidityActions(
            tokenId,
            liquidity,
            amount0Min,
            amount1Min,
            deadline
        );
        IExecutor(address(dao())).execute(_nextCallId("UNI_V3_DECREASE:"), actions, 0);
        emit LiquidityDecreased(tokenId, liquidity);
    }

    /// @inheritdoc IUniswapV3Plugin
    function collect(
        uint256 tokenId,
        uint128 amount0Max,
        uint128 amount1Max
    ) external override auth(MANAGE_POSITIONS_PERMISSION_ID) {
        Action[] memory actions = previewCollectActions(tokenId, amount0Max, amount1Max);
        (bytes[] memory results, ) = IExecutor(address(dao())).execute(
            _nextCallId("UNI_V3_COLLECT:"),
            actions,
            0
        );
        (uint256 amount0, uint256 amount1) = abi.decode(results[0], (uint256, uint256));
        emit FeesCollected(tokenId, amount0, amount1);
    }

    /// @inheritdoc IUniswapV3Plugin
    function burn(uint256 tokenId) external override auth(MANAGE_POSITIONS_PERMISSION_ID) {
        Action[] memory actions = previewBurnActions(tokenId);
        IExecutor(address(dao())).execute(_nextCallId("UNI_V3_BURN:"), actions, 0);
        emit PositionBurned(tokenId);
    }

    // --- Vote-gated admin --------------------------------------------------

    /// @inheritdoc IUniswapV3Plugin
    function setPositionManager(
        address newManager
    ) external override auth(UPDATE_POSITION_MANAGER_PERMISSION_ID) {
        if (newManager == address(0)) revert ZeroAddress();
        address previous = positionManager;
        positionManager = newManager;
        emit PositionManagerUpdated(previous, newManager);
    }

    /// @inheritdoc IUniswapV3Plugin
    /// @dev First `allowed=true` flips `allowlistEnforced` permanently (one-way,
    ///      same as the other plugins).
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

    // --- Views -------------------------------------------------------------

    /// @inheritdoc IUniswapV3Plugin
    function opNonce() external view override returns (uint256) {
        return _opNonce;
    }

    // --- Internals ---------------------------------------------------------

    function _approve(
        address token,
        address spender,
        uint256 amount
    ) private pure returns (Action memory) {
        return
            Action({to: token, value: 0, data: abi.encodeCall(IERC20.approve, (spender, amount))});
    }

    function _checkAllowed(address token) private view {
        if (allowlistEnforced && !allowedToken[token]) revert TokenNotAllowed(token);
    }

    function _nextCallId(string memory tag) private returns (bytes32) {
        unchecked {
            _opNonce += 1;
        }
        return keccak256(abi.encodePacked(tag, _opNonce));
    }
}
