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

contract UniswapV4Handler is Test {
    UniswapV4Plugin public plugin;
    MinimalDAO public dao;
    MockUniversalRouter public router;
    MockPermit2 public permit2;
    TestERC20 public tokenIn;
    TestERC20 public tokenOut;

    uint256 public ghostNonce;
    uint256 public ghostSuccessfulSwaps;
    uint256 public ghostFailedSwaps;

    modifier syncGhost() {
        _;
        uint256 current = plugin.swapNonce();
        if (current > ghostNonce) ghostNonce = current;
    }

    constructor(
        UniswapV4Plugin _plugin,
        MinimalDAO _dao,
        MockUniversalRouter _router,
        MockPermit2 _permit2,
        TestERC20 _tokenIn,
        TestERC20 _tokenOut
    ) {
        plugin = _plugin;
        dao = _dao;
        router = _router;
        permit2 = _permit2;
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
    TestERC20 public tokenIn;
    TestERC20 public tokenOut;
    UniswapV4Handler public handler;

    bytes32 internal constant TRIGGER_SWAP_PERMISSION_ID = keccak256("TRIGGER_SWAP_PERMISSION");
    bytes32 internal constant MANAGE_ALLOWLIST_PERMISSION_ID =
        keccak256("MANAGE_ALLOWLIST_PERMISSION");
    bytes32 internal constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");

    function setUp() public {
        dao = new MinimalDAO();
        router = new MockUniversalRouter();
        permit2 = new MockPermit2();
        router.setPermit2(address(permit2));
        router.setPullTokenIn(true);

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
                address(0), // v4PositionManager — swap-only invariants don't need it
                new address[](0)
            )
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        plugin = UniswapV4Plugin(address(proxy));

        handler = new UniswapV4Handler(plugin, dao, router, permit2, tokenIn, tokenOut);

        dao.grant(address(plugin), address(handler), TRIGGER_SWAP_PERMISSION_ID);
        dao.grant(address(plugin), address(handler), MANAGE_ALLOWLIST_PERMISSION_ID);
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
}
