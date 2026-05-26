// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {StdInvariant, Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";

import {AaveLendingPlugin} from "../../src/plugins/aave/AaveLendingPlugin.sol";
import {IAaveAdapter} from "../../src/plugins/aave/adapters/IAaveAdapter.sol";
import {AaveV3Adapter} from "../../src/plugins/aave/adapters/AaveV3Adapter.sol";
import {IAavePool} from "../../src/plugins/aave/adapters/IAavePool.sol";
import {MinimalDAO} from "../../src/test/mocks/MinimalDAO.sol";
import {TestERC20} from "../../src/test/mocks/TestERC20.sol";
import {MockAavePool} from "../../src/test/mocks/MockAavePool.sol";

contract AaveHandler is Test {
    AaveLendingPlugin public plugin;
    MinimalDAO public dao;
    MockAavePool public pool;
    TestERC20 public asset;

    uint256 public ghostNonce;

    modifier syncGhost() {
        _;
        uint256 current = plugin.opNonce();
        if (current > ghostNonce) ghostNonce = current;
    }

    constructor(AaveLendingPlugin _plugin, MinimalDAO _dao, MockAavePool _pool, TestERC20 _asset) {
        plugin = _plugin;
        dao = _dao;
        pool = _pool;
        asset = _asset;
    }

    function supply(uint256 amount) external syncGhost {
        amount = bound(amount, 1, 1e24);
        asset.mint(address(dao), amount);
        try plugin.supply(address(asset), amount) {} catch {}
    }

    function withdraw(uint256 amount) external syncGhost {
        amount = bound(amount, 1, 1e24);
        try plugin.withdraw(address(asset), amount) {} catch {}
    }

    function borrow(uint256 amount, uint256 mode) external syncGhost {
        amount = bound(amount, 1, 1e24);
        mode = bound(mode, 1, 2);
        // Keep the pool liquid so it can lend out (mints to its own balance).
        asset.mint(address(pool), amount);
        try plugin.borrow(address(asset), amount, mode) {} catch {}
    }

    function repay(uint256 amount, uint256 mode) external syncGhost {
        amount = bound(amount, 1, 1e24);
        mode = bound(mode, 1, 2);
        asset.mint(address(dao), amount);
        try plugin.repay(address(asset), amount, mode) {} catch {}
    }
}

contract AaveInvariantTest is StdInvariant, Test {
    AaveLendingPlugin public plugin;
    MinimalDAO public dao;
    MockAavePool public pool;
    AaveV3Adapter public adapter;
    TestERC20 public asset;
    AaveHandler public handler;

    bytes32 internal constant TRIGGER_LENDING_PERMISSION_ID =
        keccak256("TRIGGER_LENDING_PERMISSION");
    bytes32 internal constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");

    function setUp() public {
        dao = new MinimalDAO();
        pool = new MockAavePool();
        adapter = new AaveV3Adapter(IAavePool(address(pool)));
        asset = new TestERC20("AAVE-test", "AT", 18);

        AaveLendingPlugin impl = new AaveLendingPlugin();
        bytes memory initData = abi.encodeCall(
            AaveLendingPlugin.initialize,
            (IDAO(address(dao)), IAaveAdapter(address(adapter)), new address[](0))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        plugin = AaveLendingPlugin(address(proxy));

        handler = new AaveHandler(plugin, dao, pool, asset);

        dao.grant(address(plugin), address(handler), TRIGGER_LENDING_PERMISSION_ID);
        dao.grant(address(dao), address(plugin), EXECUTE_PERMISSION_ID);

        targetContract(address(handler));
    }

    /// @notice Plugin never custodies the asset. The DAO calls the pool
    ///         directly; funds move DAO <-> pool. The plugin is only on the
    ///         call path (TRD §6.2 custody model).
    function invariant_pluginHoldsNoAsset() public {
        assertEq(asset.balanceOf(address(plugin)), 0, "plugin custody leak (asset)");
    }

    function invariant_pluginHoldsNoEth() public {
        assertEq(address(plugin).balance, 0, "plugin custody leak (ETH)");
    }

    /// @notice After any successful supply or repay, the DAO's allowance to
    ///         the pool must be zero. The plugin approves `amount` exactly;
    ///         the pool's `transferFrom(dao, ..., amount)` consumes it, and
    ///         repay's third action resets any residual to 0.
    function invariant_zeroResidualPoolAllowance() public {
        assertEq(
            asset.allowance(address(dao), adapter.poolAddress()),
            0,
            "residual DAO->pool allowance after lending op"
        );
    }

    /// @notice opNonce is strictly monotonic — every successful supply /
    ///         withdraw / borrow / repay increments it once. Failures leave
    ///         it untouched. Catches wrap-around / reset regressions.
    function invariant_opNonceMonotonic() public {
        assertGe(plugin.opNonce(), handler.ghostNonce(), "opNonce regressed");
    }

    /// @notice The adapter is stateless — it must never accumulate the asset
    ///         either (it's only a calldata builder; the DAO calls the pool).
    function invariant_adapterHoldsNoAsset() public {
        assertEq(asset.balanceOf(address(adapter)), 0, "adapter custody leak");
    }
}
