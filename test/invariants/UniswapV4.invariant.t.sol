// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {StdInvariant, Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";

import {UniswapV4Plugin} from "../../src/plugins/uniswap-v4/UniswapV4Plugin.sol";
import {MinimalDAO} from "../../src/test/mocks/MinimalDAO.sol";
import {TestERC20} from "../../src/test/mocks/TestERC20.sol";
import {MockUniversalRouter} from "../../src/test/mocks/MockUniversalRouter.sol";
import {MockPermit2} from "../../src/test/mocks/MockPermit2.sol";
import {MockV4PositionManager} from "../../src/test/mocks/MockV4PositionManager.sol";

contract UniswapV4Handler is Test {
    UniswapV4Plugin public plugin;
    MinimalDAO public dao;
    MockUniversalRouter public router;
    MockPermit2 public permit2;
    MockV4PositionManager public pm;
    TestERC20 public tokenIn;
    TestERC20 public tokenOut;

    uint256 public ghostNonce;
    uint256 public ghostLpNonce;
    uint256 public ghostSuccessfulSwaps;
    uint256 public ghostFailedSwaps;
    uint256 public ghostSuccessfulLpOps;
    uint256 public ghostFailedLpOps;

    // Pre-computed valid (but actionless) unlock envelope: the v4 LP MintRecipient
    // check expects abi.encode(bytes, bytes[]) shape, but a zero-length action
    // stream is harmless — the handler exercises the surrounding allowance +
    // PM-call + slippage choreography, not the action stream itself.
    bytes internal constant EMPTY_UNLOCK =
        hex"00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

    modifier syncGhost() {
        _;
        uint256 current = plugin.swapNonce();
        if (current > ghostNonce) ghostNonce = current;
        uint256 currentLp = plugin.lpNonce();
        if (currentLp > ghostLpNonce) ghostLpNonce = currentLp;
    }

    constructor(
        UniswapV4Plugin _plugin,
        MinimalDAO _dao,
        MockUniversalRouter _router,
        MockPermit2 _permit2,
        MockV4PositionManager _pm,
        TestERC20 _tokenIn,
        TestERC20 _tokenOut
    ) {
        plugin = _plugin;
        dao = _dao;
        router = _router;
        permit2 = _permit2;
        pm = _pm;
        tokenIn = _tokenIn;
        tokenOut = _tokenOut;
    }

    function swap(uint256 amountIn, uint256 amountOut, uint256 minOut) external syncGhost {
        amountIn = bound(amountIn, 1, 1e24);
        amountOut = bound(amountOut, 0, 1e24);
        minOut = bound(minOut, 0, amountOut);

        // Mint inputs to the DAO + outputs to the router for the next swap.
        tokenIn.mint(address(dao), amountIn);
        tokenOut.mint(address(router), amountOut);

        router.setSwap(
            address(tokenIn),
            amountIn,
            address(tokenOut),
            amountOut,
            address(dao),
            address(dao)
        );

        bytes[] memory inputs = new bytes[](0);
        try
            plugin.swap(
                "",
                inputs,
                block.timestamp + 1 hours,
                address(tokenIn),
                amountIn,
                address(tokenOut),
                minOut
            )
        {
            ghostSuccessfulSwaps++;
        } catch {
            ghostFailedSwaps++;
        }
    }

    /// @notice Exercise the v4 LP path. The handler chooses between a pull-leg
    ///         (mint/increase shape — DAO pays input) and a push-leg (decrease/
    ///         burn shape — DAO receives output), then calls modifyLiquidities.
    ///         Failures are tolerated (e.g. allowlist mismatch); the invariants
    ///         care about post-call state, not happy-path frequency.
    function modifyLiquidities(uint256 amount, bool pullLeg, bool useTokenIn) external syncGhost {
        amount = bound(amount, 1, 1e24);
        TestERC20 tok = useTokenIn ? tokenIn : tokenOut;

        pm.clearLegs();
        address[] memory inputs;
        uint256[] memory maxIns;
        address[] memory outputs;
        uint256[] memory minOuts;

        if (pullLeg) {
            tok.mint(address(dao), amount);
            pm.addPullLeg(address(tok), amount, address(dao));
            inputs = new address[](1);
            inputs[0] = address(tok);
            maxIns = new uint256[](1);
            maxIns[0] = amount;
            outputs = new address[](0);
            minOuts = new uint256[](0);
        } else {
            tok.mint(address(pm), amount);
            pm.addPushLeg(address(tok), amount, address(dao));
            inputs = new address[](0);
            maxIns = new uint256[](0);
            outputs = new address[](1);
            outputs[0] = address(tok);
            minOuts = new uint256[](1);
            minOuts[0] = amount;
        }

        try
            plugin.modifyLiquidities(
                EMPTY_UNLOCK,
                block.timestamp + 1 hours,
                inputs,
                maxIns,
                outputs,
                minOuts
            )
        {
            ghostSuccessfulLpOps++;
        } catch {
            ghostFailedLpOps++;
        }
    }

    function setAllowedToken(uint256 seed, bool allowed) external syncGhost {
        // Cycle through the two known tokens + a random third to exercise
        // both allowed-known and allowed-unknown paths.
        address[3] memory candidates = [
            address(tokenIn),
            address(tokenOut),
            address(uint160(uint256(keccak256(abi.encode(seed)))))
        ];
        address tok = candidates[seed % 3];
        try plugin.setAllowedToken(tok, allowed) {} catch {}
    }
}

contract UniswapV4InvariantTest is StdInvariant, Test {
    UniswapV4Plugin public plugin;
    MinimalDAO public dao;
    MockUniversalRouter public router;
    MockPermit2 public permit2;
    MockV4PositionManager public pm;
    TestERC20 public tokenIn;
    TestERC20 public tokenOut;
    UniswapV4Handler public handler;

    bytes32 internal constant TRIGGER_SWAP_PERMISSION_ID = keccak256("TRIGGER_SWAP_PERMISSION");
    bytes32 internal constant MANAGE_ALLOWLIST_PERMISSION_ID =
        keccak256("MANAGE_ALLOWLIST_PERMISSION");
    bytes32 internal constant MANAGE_POSITIONS_PERMISSION_ID =
        keccak256("MANAGE_POSITIONS_PERMISSION");
    bytes32 internal constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");

    function setUp() public {
        dao = new MinimalDAO();
        router = new MockUniversalRouter();
        permit2 = new MockPermit2();
        router.setPermit2(address(permit2));
        router.setPullTokenIn(true);
        pm = new MockV4PositionManager();
        pm.setPermit2(address(permit2));

        tokenIn = new TestERC20("In", "IN", 18);
        tokenOut = new TestERC20("Out", "OUT", 18);

        UniswapV4Plugin impl = new UniswapV4Plugin();
        bytes memory initData = abi.encodeCall(
            UniswapV4Plugin.initialize,
            (
                IDAO(address(dao)),
                address(router),
                address(permit2),
                address(0xbeef), // poolManager — opaque to the plugin's logic
                address(pm),
                new address[](0)
            )
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        plugin = UniswapV4Plugin(address(proxy));

        handler = new UniswapV4Handler(plugin, dao, router, permit2, pm, tokenIn, tokenOut);

        dao.grant(address(plugin), address(handler), TRIGGER_SWAP_PERMISSION_ID);
        dao.grant(address(plugin), address(handler), MANAGE_ALLOWLIST_PERMISSION_ID);
        dao.grant(address(plugin), address(handler), MANAGE_POSITIONS_PERMISSION_ID);
        dao.grant(address(dao), address(plugin), EXECUTE_PERMISSION_ID);

        targetContract(address(handler));
    }

    /// @notice The plugin never custodies tokenIn or tokenOut. All approvals
    ///         flow DAO → Permit2; the router pulls from the DAO directly via
    ///         Permit2.transferFrom. Plugin only orchestrates the batch.
    function invariant_pluginHoldsNoTokenIn() public {
        assertEq(tokenIn.balanceOf(address(plugin)), 0, "plugin custody leak (tokenIn)");
    }

    function invariant_pluginHoldsNoTokenOut() public {
        assertEq(tokenOut.balanceOf(address(plugin)), 0, "plugin custody leak (tokenOut)");
    }

    function invariant_pluginHoldsNoEth() public {
        assertEq(address(plugin).balance, 0, "plugin custody leak (ETH)");
    }

    /// @notice After a successful swap, the DAO's ERC20 allowance to Permit2
    ///         must be exactly zero — the plugin approves `amountIn` exactly,
    ///         and Permit2.transferFrom consumes the full allowance during
    ///         settlement. A residual non-zero allowance would mean either
    ///         the plugin approved too much or the router consumed too little,
    ///         both of which are funds-at-risk regressions (TRD §11).
    function invariant_zeroResidualPermit2Allowance() public {
        assertEq(
            tokenIn.allowance(address(dao), address(permit2)),
            0,
            "residual DAO->Permit2 allowance after swap"
        );
    }

    /// @notice swapNonce is monotonic. Successful swaps increment it; failed
    ///         swaps (e.g. slippage breach reverts the whole batch) leave it
    ///         untouched. Catches a regression that resets or wraps the nonce.
    function invariant_swapNonceMonotonic() public {
        assertGe(plugin.swapNonce(), handler.ghostNonce(), "swapNonce regressed");
    }

    /// @notice lpNonce is monotonic on the same terms as swapNonce, in its own
    ///         counter space — the V4 LP extension intentionally uses an
    ///         independent nonce so the subgraph can correlate
    ///         `LiquidityModified ↔ Executed` 1:1 without aliasing with swap
    ///         events. A regression here would mean either a reset or a
    ///         shared-counter regression with `swapNonce`.
    function invariant_lpNonceMonotonic() public {
        assertGe(plugin.lpNonce(), handler.ghostLpNonce(), "lpNonce regressed");
    }
}
