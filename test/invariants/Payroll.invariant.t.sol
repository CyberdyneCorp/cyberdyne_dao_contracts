// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {StdInvariant, Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";

import {PayrollPlugin} from "../../src/plugins/payroll/PayrollPlugin.sol";
import {IPayrollPlugin} from "../../src/plugins/payroll/IPayrollPlugin.sol";
import {MinimalDAO} from "../../src/test/mocks/MinimalDAO.sol";
import {TestERC20} from "../../src/test/mocks/TestERC20.sol";

/// @dev Bounded random caller for PayrollPlugin. The Foundry invariant runner
///      picks one of these methods + random args each step (depth=50 by default).
contract PayrollHandler is Test {
    PayrollPlugin public plugin;
    MinimalDAO public dao;
    TestERC20 public token;

    address[] public payees;
    uint256 public ghostLastPeriod;
    uint256 public ghostSuccessfulCranks;
    uint256 public ghostFailedCranks;

    // Each call: track current state into ghost vars at the END for the
    // monotonicity invariant.
    modifier syncGhost() {
        _;
        uint256 current = plugin.lastPayoutPeriod();
        if (current > ghostLastPeriod) ghostLastPeriod = current;
    }

    constructor(PayrollPlugin _plugin, MinimalDAO _dao, TestERC20 _token) {
        plugin = _plugin;
        dao = _dao;
        token = _token;
    }

    function addRecipient(uint256 seed, uint256 amount) external syncGhost {
        amount = bound(amount, 1, 1e24);
        // Synthesize a payee. The +1 dodges the zero address; the +block.number
        // adds entropy across runs.
        address payee = address(
            uint160(uint256(keccak256(abi.encode(seed, payees.length, block.number))) | 1)
        );
        if (payee == address(0)) return;
        try plugin.addRecipient(payee, address(token), amount, "") {
            payees.push(payee);
        } catch {}
    }

    function removeRecipient(uint256 idx) external syncGhost {
        if (payees.length == 0) return;
        idx = bound(idx, 0, payees.length - 1);
        try plugin.removeRecipient(payees[idx]) {} catch {}
    }

    function setAmount(uint256 idx, uint256 newAmount) external syncGhost {
        if (payees.length == 0) return;
        idx = bound(idx, 0, payees.length - 1);
        newAmount = bound(newAmount, 1, 1e24);
        try plugin.setAmount(payees[idx], newAmount) {} catch {}
    }

    function setPayDayOfMonth(uint8 day) external syncGhost {
        day = uint8(bound(uint256(day), 1, 28));
        try plugin.setPayDayOfMonth(day) {} catch {}
    }

    /// @dev Fuzz the settable cap across (and beyond) its valid range. The
    ///      setter rejects values below the live slot count, so the
    ///      `recipientCountBounded` invariant must hold for any accepted value.
    function setMaxRecipients(uint256 newMax) external syncGhost {
        newMax = bound(newMax, 0, plugin.MAX_RECIPIENTS_CEILING());
        try plugin.setMaxRecipients(newMax) {} catch {}
    }

    /// @dev Funds the DAO so the next crank actually moves tokens; without
    ///      this every crank would revert OOF and the no-custody invariant
    ///      would be trivially true. We want real fund flow under fuzz.
    function fundDao(uint256 amount) external syncGhost {
        amount = bound(amount, 0, 1e30);
        token.mint(address(dao), amount);
        // Also top up ETH so ETH-recipient crank sequences (if any) have funds.
        // We never add ETH recipients in this handler, but the topup is cheap.
        vm.deal(address(dao), bound(amount, 0, 1000 ether));
    }

    function executePayroll(uint256 jump) external syncGhost {
        // Jump anywhere from 1 hour to ~3 months. The crank's calendar logic
        // decides what's valid; failures are absorbed into ghostFailedCranks.
        jump = bound(jump, 1 hours, 100 days);
        vm.warp(block.timestamp + jump);
        try plugin.executePayroll() {
            ghostSuccessfulCranks++;
        } catch {
            ghostFailedCranks++;
        }
    }

    /// @dev Exercise the paginated crank under fuzz alongside the single-pass
    ///      one — random page sizes walk the cursor across multiple calls.
    function executePayrollPage(uint256 jump, uint256 maxCount) external syncGhost {
        jump = bound(jump, 1 hours, 100 days);
        maxCount = bound(maxCount, 1, plugin.MAX_RECIPIENTS_PER_PAGE());
        vm.warp(block.timestamp + jump);
        try plugin.executePayrollPage(maxCount) {
            ghostSuccessfulCranks++;
        } catch {
            ghostFailedCranks++;
        }
    }

    function payeesCount() external view returns (uint256) {
        return payees.length;
    }
}

contract PayrollInvariantTest is StdInvariant, Test {
    PayrollPlugin public plugin;
    MinimalDAO public dao;
    TestERC20 public token;
    PayrollHandler public handler;

    bytes32 internal constant MANAGE_PAYROLL_PERMISSION_ID = keccak256("MANAGE_PAYROLL_PERMISSION");
    bytes32 internal constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");

    function setUp() public {
        dao = new MinimalDAO();
        token = new TestERC20("Invariant", "INV", 18);

        PayrollPlugin impl = new PayrollPlugin();
        bytes memory initData = abi.encodeCall(
            PayrollPlugin.initialize,
            (IDAO(address(dao)), uint8(15))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        plugin = PayrollPlugin(address(proxy));

        handler = new PayrollHandler(plugin, dao, token);

        // Grant the handler the management permission (the handler stands in
        // for "any caller who came in through a DAO vote"). Plugin needs
        // EXECUTE on the DAO to actually move funds during the crank.
        dao.grant(address(plugin), address(handler), MANAGE_PAYROLL_PERMISSION_ID);
        dao.grant(address(dao), address(plugin), EXECUTE_PERMISSION_ID);

        // Tell Foundry to only call the handler — random calls to plugin/dao
        // directly would be off-spec.
        targetContract(address(handler));
    }

    /// @notice Plugin must never custody the ERC20 used in payroll. All funds
    ///         live in the DAO; the plugin only builds Action[]. If a future
    ///         change accidentally routes funds to the plugin (e.g. via a
    ///         misencoded transfer), this invariant catches it.
    function invariant_pluginHoldsNoToken() public {
        assertEq(token.balanceOf(address(plugin)), 0, "plugin custody leak (ERC20)");
    }

    /// @notice Plugin must never hold ETH. There is no `receive()` /
    ///         `fallback()` on the plugin; this invariant catches a
    ///         regression that adds one.
    function invariant_pluginHoldsNoEth() public {
        assertEq(address(plugin).balance, 0, "plugin custody leak (ETH)");
    }

    /// @notice `lastPayoutPeriod` is strictly monotonic. A successful crank
    ///         can only ever advance it; a failed crank leaves it untouched.
    ///         The ghost variable mirrors the handler's view; we assert the
    ///         contract state never falls below it.
    function invariant_lastPayoutPeriodMonotonic() public {
        assertGe(
            plugin.lastPayoutPeriod(),
            handler.ghostLastPeriod(),
            "lastPayoutPeriod regressed"
        );
    }

    /// @notice `recipientCount` never exceeds the cap. The cap is the design
    ///         ceiling that bounds the storage scan a paginated crank performs.
    function invariant_recipientCountBounded() public {
        assertLe(plugin.recipientCount(), plugin.MAX_RECIPIENTS(), "recipient cap breached");
    }

    /// @notice The pagination cursor never points past the recipient set. It is
    ///         only ever set to a mid-scan index (`< length`) or reset to 0 when
    ///         a period completes; `_recipients` never shrinks. A cursor beyond
    ///         the end would skip recipients or read out of bounds.
    function invariant_payoutCursorWithinBounds() public {
        assertLe(plugin.payoutCursor(), plugin.recipientCount(), "payout cursor past end");
    }
}
