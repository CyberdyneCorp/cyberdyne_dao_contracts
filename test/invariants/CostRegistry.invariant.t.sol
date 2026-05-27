// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {StdInvariant, Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CostRegistryPlugin} from "../../src/plugins/cost-registry/CostRegistryPlugin.sol";
import {ICostRegistryPlugin} from "../../src/plugins/cost-registry/ICostRegistryPlugin.sol";
import {MinimalDAO} from "../../src/test/mocks/MinimalDAO.sol";
import {TestERC20} from "../../src/test/mocks/TestERC20.sol";

/// @dev Bounded random caller for CostRegistryPlugin.
contract CostRegistryHandler is Test {
    CostRegistryPlugin public plugin;
    MinimalDAO public dao;
    TestERC20 public token;

    uint256 public addrNonce;

    constructor(CostRegistryPlugin _plugin, MinimalDAO _dao, TestERC20 _token) {
        plugin = _plugin;
        dao = _dao;
        token = _token;
    }

    function registerEntry(uint256 cost, uint32 freq) external {
        cost = bound(cost, 1, 1e24);
        freq = uint32(bound(uint256(freq), 1, 365));
        address payee = address(
            uint160(uint256(keccak256(abi.encode(addrNonce++, block.number))) | 1)
        );
        try plugin.registerEntry("c", "d", cost, freq, payee) {} catch {}
    }

    function updateEntry(uint256 id, uint256 cost, uint32 freq) external {
        uint256 n = plugin.entryCount();
        if (n == 0) return;
        id = bound(id, 0, n - 1);
        cost = bound(cost, 1, 1e24);
        freq = uint32(bound(uint256(freq), 1, 365));
        address payee = address(uint160(uint256(keccak256(abi.encode(addrNonce++, id))) | 1));
        try plugin.updateEntry(id, "c", "d", cost, freq, payee) {} catch {}
    }

    function removeEntry(uint256 id) external {
        uint256 n = plugin.entryCount();
        if (n == 0) return;
        id = bound(id, 0, n - 1);
        try plugin.removeEntry(id) {} catch {}
    }

    /// @dev Fuzz the settable cap. The setter rejects values below the live
    ///      slot count, so `entryCountBounded` must hold for any accepted value.
    function setMaxEntries(uint256 newMax) external {
        newMax = bound(newMax, 0, plugin.MAX_ENTRIES_CEILING());
        try plugin.setMaxEntries(newMax) {} catch {}
    }

    function fundDao(uint256 amount) external {
        amount = bound(amount, 0, 1e30);
        token.mint(address(dao), amount);
    }

    function processDue(uint256 offset, uint256 limit, uint256 jump) external {
        uint256 n = plugin.entryCount();
        offset = n == 0 ? 0 : bound(offset, 0, n);
        limit = bound(limit, 1, plugin.MAX_PER_PAGE());
        jump = bound(jump, 0, 400 days);
        vm.warp(block.timestamp + jump);
        try plugin.processDue(offset, limit) {} catch {}
    }
}

contract CostRegistryInvariantTest is StdInvariant, Test {
    CostRegistryPlugin public plugin;
    MinimalDAO public dao;
    TestERC20 public token;
    CostRegistryHandler public handler;

    bytes32 internal constant MANAGE_COSTS_PERMISSION_ID = keccak256("MANAGE_COSTS_PERMISSION");
    bytes32 internal constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");

    function setUp() public {
        dao = new MinimalDAO();
        token = new TestERC20("USD Coin", "USDC", 6);

        CostRegistryPlugin impl = new CostRegistryPlugin();
        bytes memory initData = abi.encodeCall(
            CostRegistryPlugin.initialize,
            (IDAO(address(dao)), IERC20(address(token)))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        plugin = CostRegistryPlugin(address(proxy));

        handler = new CostRegistryHandler(plugin, dao, token);

        dao.grant(address(plugin), address(handler), MANAGE_COSTS_PERMISSION_ID);
        dao.grant(address(dao), address(plugin), EXECUTE_PERMISSION_ID);

        targetContract(address(handler));
    }

    /// @notice Plugin never custodies the payment token — funds flow DAO → payee.
    function invariant_pluginHoldsNoToken() public {
        assertEq(token.balanceOf(address(plugin)), 0, "plugin custody leak (token)");
    }

    /// @notice Plugin never holds ETH (no receive/fallback).
    function invariant_pluginHoldsNoEth() public {
        assertEq(address(plugin).balance, 0, "plugin custody leak (ETH)");
    }

    /// @notice Entry count never exceeds the cap that bounds the crank's scan.
    function invariant_entryCountBounded() public {
        assertLe(plugin.entryCount(), plugin.MAX_ENTRIES(), "entry cap breached");
    }

    /// @notice No entry's payment clock is ever set into the future — the crank
    ///         only ever sets `lastPaidAt = block.timestamp`, and registration
    ///         stamps the current time. A future clock would silently defer
    ///         (or, with underflow elsewhere, double-pay) entries.
    function invariant_lastPaidNeverInFuture() public {
        uint256 n = plugin.entryCount();
        for (uint256 i; i < n; ++i) {
            ICostRegistryPlugin.CostEntry memory e = plugin.getEntry(i);
            assertLe(uint256(e.lastPaidAt), block.timestamp, "lastPaidAt in the future");
        }
    }
}
