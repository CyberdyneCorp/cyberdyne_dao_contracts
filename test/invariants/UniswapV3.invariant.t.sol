// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {StdInvariant, Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";

import {UniswapV3Plugin} from "../../src/plugins/uniswap-v3/UniswapV3Plugin.sol";
import {IUniswapV3Plugin} from "../../src/plugins/uniswap-v3/IUniswapV3Plugin.sol";
import {MinimalDAO} from "../../src/test/mocks/MinimalDAO.sol";
import {TestERC20} from "../../src/test/mocks/TestERC20.sol";
import {MockNonfungiblePositionManager} from "../../src/test/mocks/MockNonfungiblePositionManager.sol";

/// @dev Bounded random caller for UniswapV3Plugin against a mock NPM.
contract UniV3Handler is Test {
    UniswapV3Plugin public plugin;
    MinimalDAO public dao;
    MockNonfungiblePositionManager public npm;
    TestERC20 public t0;
    TestERC20 public t1;

    uint256 public lastTokenId;
    uint256 public ghostNonce;

    modifier syncGhost() {
        _;
        uint256 cur = plugin.opNonce();
        if (cur > ghostNonce) ghostNonce = cur;
    }

    constructor(
        UniswapV3Plugin _plugin,
        MinimalDAO _dao,
        MockNonfungiblePositionManager _npm,
        TestERC20 _t0,
        TestERC20 _t1
    ) {
        plugin = _plugin;
        dao = _dao;
        npm = _npm;
        t0 = _t0;
        t1 = _t1;
    }

    function fundDao(uint256 a0, uint256 a1) external syncGhost {
        t0.mint(address(dao), bound(a0, 0, 1e27));
        t1.mint(address(dao), bound(a1, 0, 1e27));
    }

    function mint(uint256 a0, uint256 a1) external syncGhost {
        a0 = bound(a0, 1, 1e24);
        a1 = bound(a1, 1, 1e24);
        IUniswapV3Plugin.MintParams memory p = IUniswapV3Plugin.MintParams({
            token0: address(t0),
            token1: address(t1),
            fee: 3000,
            tickLower: -887220,
            tickUpper: 887220,
            amount0Desired: a0,
            amount1Desired: a1,
            amount0Min: 0,
            amount1Min: 0,
            deadline: type(uint256).max
        });
        try plugin.mint(p) {
            lastTokenId = npm.nextId();
        } catch {}
    }

    function increase(uint256 a0, uint256 a1) external syncGhost {
        if (lastTokenId == 0) return;
        a0 = bound(a0, 1, 1e24);
        a1 = bound(a1, 1, 1e24);
        try plugin.increaseLiquidity(lastTokenId, a0, a1, 0, 0, type(uint256).max) {} catch {}
    }

    function decrease(uint256 liq) external syncGhost {
        if (lastTokenId == 0) return;
        (, , , , , , , uint128 liquidity, , , , ) = npm.positions(lastTokenId);
        if (liquidity == 0) return;
        uint128 toRemove = uint128(bound(liq, 1, liquidity));
        try plugin.decreaseLiquidity(lastTokenId, toRemove, 0, 0, type(uint256).max) {} catch {}
    }

    function collect() external syncGhost {
        if (lastTokenId == 0) return;
        try plugin.collect(lastTokenId, type(uint128).max, type(uint128).max) {} catch {}
    }

    function burn() external syncGhost {
        if (lastTokenId == 0) return;
        try plugin.burn(lastTokenId) {} catch {}
    }
}

contract UniswapV3InvariantTest is StdInvariant, Test {
    UniswapV3Plugin public plugin;
    MinimalDAO public dao;
    MockNonfungiblePositionManager public npm;
    TestERC20 public t0;
    TestERC20 public t1;
    UniV3Handler public handler;

    bytes32 internal constant MANAGE_POSITIONS_PERMISSION_ID =
        keccak256("MANAGE_POSITIONS_PERMISSION");
    bytes32 internal constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");

    function setUp() public {
        dao = new MinimalDAO();
        npm = new MockNonfungiblePositionManager();
        t0 = new TestERC20("T0", "T0", 18);
        t1 = new TestERC20("T1", "T1", 18);

        UniswapV3Plugin impl = new UniswapV3Plugin();
        bytes memory initData = abi.encodeCall(
            UniswapV3Plugin.initialize,
            (IDAO(address(dao)), address(npm), new address[](0))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        plugin = UniswapV3Plugin(address(proxy));

        handler = new UniV3Handler(plugin, dao, npm, t0, t1);
        dao.grant(address(plugin), address(handler), MANAGE_POSITIONS_PERMISSION_ID);
        dao.grant(address(dao), address(plugin), EXECUTE_PERMISSION_ID);

        targetContract(address(handler));
    }

    /// @notice Plugin never custodies either token — funds flow DAO <-> NPM.
    function invariant_pluginHoldsNoToken0() public {
        assertEq(t0.balanceOf(address(plugin)), 0, "plugin custody leak (token0)");
    }

    function invariant_pluginHoldsNoToken1() public {
        assertEq(t1.balanceOf(address(plugin)), 0, "plugin custody leak (token1)");
    }

    function invariant_pluginHoldsNoEth() public {
        assertEq(address(plugin).balance, 0, "plugin custody leak (ETH)");
    }

    /// @notice No residual DAO->NPM allowance survives an op: every mint /
    ///         increase approves an exact amount then resets to 0 in the batch.
    function invariant_zeroResidualAllowance() public {
        assertEq(t0.allowance(address(dao), address(npm)), 0, "residual token0 allowance");
        assertEq(t1.allowance(address(dao), address(npm)), 0, "residual token1 allowance");
    }

    /// @notice opNonce is strictly monotonic — each successful op increments it.
    function invariant_opNonceMonotonic() public {
        assertGe(plugin.opNonce(), handler.ghostNonce(), "opNonce regressed");
    }
}
