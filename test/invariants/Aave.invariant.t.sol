// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {StdInvariant, Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";

import {AaveLendingPlugin} from "../../src/plugins/aave/AaveLendingPlugin.sol";
import {IAaveAdapter} from "../../src/plugins/aave/adapters/IAaveAdapter.sol";
import {MinimalDAO} from "../../src/test/mocks/MinimalDAO.sol";
import {TestERC20} from "../../src/test/mocks/TestERC20.sol";
import {MockAaveAdapter} from "../../src/test/mocks/MockAaveAdapter.sol";

contract AaveHandler is Test {
    AaveLendingPlugin public plugin;
    MinimalDAO public dao;
    MockAaveAdapter public adapter;
    TestERC20 public asset;

    uint256 public ghostNonce;
    uint256 public ghostSuccessfulSupplies;
    uint256 public ghostSuccessfulBorrows;
    uint256 public ghostSuccessfulRepays;
    uint256 public ghostSuccessfulWithdraws;

    modifier syncGhost() {
        _;
        uint256 current = plugin.opNonce();
        if (current > ghostNonce) ghostNonce = current;
    }

    constructor(AaveLendingPlugin _plugin, MinimalDAO _dao, MockAaveAdapter _adapter, TestERC20 _asset) {
        plugin = _plugin;
        dao = _dao;
        adapter = _adapter;
        asset = _asset;
    }

    function supply(uint256 amount) external syncGhost {
        amount = bound(amount, 1, 1e24);
        asset.mint(address(dao), amount);
        try plugin.supply(address(asset), amount) {
            ghostSuccessfulSupplies++;
        } catch {}
    }

    function withdraw(uint256 amount) external syncGhost {
        amount = bound(amount, 1, 1e24);
        try plugin.withdraw(address(asset), amount) {
            ghostSuccessfulWithdraws++;
        } catch {}
    }

    function borrow(uint256 amount, uint256 mode) external syncGhost {
        amount = bound(amount, 1, 1e24);
        mode = bound(mode, 1, 2);
        // Pre-fund the adapter so it has something to lend out.
        asset.mint(address(adapter), amount);
        try plugin.borrow(address(asset), amount, mode) {
            ghostSuccessfulBorrows++;
        } catch {}
    }

    function repay(uint256 amount, uint256 mode) external syncGhost {
        amount = bound(amount, 1, 1e24);
        mode = bound(mode, 1, 2);
        // Make sure the DAO has tokens to pay with.
        asset.mint(address(dao), amount);
        try plugin.repay(address(asset), amount, mode) {
            ghostSuccessfulRepays++;
        } catch {}
    }
}

contract AaveInvariantTest is StdInvariant, Test {
    AaveLendingPlugin public plugin;
    MinimalDAO public dao;
    MockAaveAdapter public adapter;
    TestERC20 public asset;
    AaveHandler public handler;

    bytes32 internal constant TRIGGER_LENDING_PERMISSION_ID = keccak256("TRIGGER_LENDING_PERMISSION");
    bytes32 internal constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");

    function setUp() public {
        dao = new MinimalDAO();
        adapter = new MockAaveAdapter();
        asset = new TestERC20("AAVE-test", "AT", 18);

        AaveLendingPlugin impl = new AaveLendingPlugin();
        bytes memory initData = abi.encodeCall(
            AaveLendingPlugin.initialize,
            (IDAO(address(dao)), IAaveAdapter(address(adapter)), new address[](0))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        plugin = AaveLendingPlugin(address(proxy));

        handler = new AaveHandler(plugin, dao, adapter, asset);

        dao.grant(address(plugin), address(handler), TRIGGER_LENDING_PERMISSION_ID);
        dao.grant(address(dao), address(plugin), EXECUTE_PERMISSION_ID);

        targetContract(address(handler));
    }

    /// @notice Plugin never custodies the asset. Supplies move DAO → adapter;
    ///         withdraws move adapter → DAO; borrows move adapter → DAO;
    ///         repays move DAO → adapter. The plugin is only on the call
    ///         path — funds bypass it entirely (TRD §6.2 custody model).
    function invariant_pluginHoldsNoAsset() public {
        assertEq(asset.balanceOf(address(plugin)), 0, "plugin custody leak (asset)");
    }

    function invariant_pluginHoldsNoEth() public {
        assertEq(address(plugin).balance, 0, "plugin custody leak (ETH)");
    }

    /// @notice After any successful supply or repay, the DAO's allowance to
    ///         the adapter's pool address must be zero. The plugin approves
    ///         `amount` exactly, then the adapter's `transferFrom(dao, ...,
    ///         amount)` consumes it precisely.
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
}
