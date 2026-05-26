// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PluginUUPSUpgradeable} from "@aragon/osx-commons-contracts/src/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {IExecutor, Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

import {IPayrollPlugin} from "./IPayrollPlugin.sol";
import {BokkyPooBahsDateTimeLibrary as DT} from "./lib/BokkyPooBahsDateTimeLibrary.sol";

/// @title PayrollPlugin
/// @notice Fixed-list monthly payroll on Aragon OSx.
///         Recipient management is vote-gated; the monthly `executePayroll`
///         crank is permissionless. Missed months are skipped — no back-pay.
/// @dev    Plugin never custodies funds. Transfers flow DAO → payee via
///         `IExecutor.execute` with `allowFailureMap = (1 << n) - 1` so one
///         reverting recipient never halts the run for the rest.
contract PayrollPlugin is PluginUUPSUpgradeable, IPayrollPlugin {
    bytes32 public constant MANAGE_PAYROLL_PERMISSION_ID = keccak256("MANAGE_PAYROLL_PERMISSION");

    /// @inheritdoc IPayrollPlugin
    /// @dev OSx DAO.execute caps at 256 actions; we cap at 100 to leave headroom
    ///      for gas (TRD §11). Larger payrolls need the paginated crank (v1.1).
    uint256 public constant override MAX_RECIPIENTS = 100;

    Recipient[] private _recipients;
    /// @dev 1-based index into `_recipients`; 0 = absent. Lets us treat 0 as a
    ///      sentinel without losing slot 0.
    mapping(address => uint256) public indexOfPayee;

    uint8 public override payDayOfMonth;
    uint256 public override lastPayoutPeriod;

    uint256[47] private __gap;

    /// @notice Initialize the plugin. Called once via the UUPS proxy constructor.
    function initialize(IDAO _dao, uint8 _payDayOfMonth) external initializer {
        __PluginUUPSUpgradeable_init(_dao);
        if (_payDayOfMonth == 0 || _payDayOfMonth > 28) {
            revert InvalidPayDayOfMonth(_payDayOfMonth);
        }
        payDayOfMonth = _payDayOfMonth;
    }

    // --- Vote-gated management --------------------------------------------

    /// @inheritdoc IPayrollPlugin
    function addRecipient(
        address payee,
        address token,
        uint256 amount
    ) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        if (payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (indexOfPayee[payee] != 0) revert RecipientAlreadyExists(payee);
        if (_recipients.length >= MAX_RECIPIENTS) {
            revert RecipientLimitExceeded(MAX_RECIPIENTS);
        }

        _recipients.push(Recipient({payee: payee, token: token, amount: amount, active: true}));
        indexOfPayee[payee] = _recipients.length; // 1-based

        emit RecipientAdded(payee, token, amount);
    }

    /// @inheritdoc IPayrollPlugin
    /// @dev Soft delete — slot is marked inactive but kept so prior payout
    ///      history (events / subgraph) keeps a stable foreign key.
    function removeRecipient(address payee) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        uint256 idx = indexOfPayee[payee];
        if (idx == 0) revert RecipientNotFound(payee);

        Recipient storage r = _recipients[idx - 1];
        if (!r.active) revert RecipientNotFound(payee); // already soft-deleted
        r.active = false;

        emit RecipientRemoved(payee);
    }

    /// @inheritdoc IPayrollPlugin
    function setAmount(
        address payee,
        uint256 newAmount
    ) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        if (newAmount == 0) revert ZeroAmount();
        uint256 idx = indexOfPayee[payee];
        if (idx == 0) revert RecipientNotFound(payee);

        Recipient storage r = _recipients[idx - 1];
        if (!r.active) revert RecipientNotFound(payee);

        uint256 oldAmount = r.amount;
        r.amount = newAmount;
        emit RecipientAmountUpdated(payee, oldAmount, newAmount);
    }

    /// @inheritdoc IPayrollPlugin
    function setPayDayOfMonth(uint8 day) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        if (day == 0 || day > 28) revert InvalidPayDayOfMonth(day);
        uint8 previous = payDayOfMonth;
        payDayOfMonth = day;
        emit PayDayUpdated(previous, day);
    }

    // --- Permissionless monthly crank -------------------------------------

    /// @inheritdoc IPayrollPlugin
    function executePayroll() external override {
        (uint256 year, uint256 month, uint256 day) = DT.timestampToDate(block.timestamp);
        uint256 currentPeriod = year * 12 + month;

        if (currentPeriod <= lastPayoutPeriod) {
            revert AlreadyPaidThisPeriod(currentPeriod);
        }
        if (day < payDayOfMonth) {
            revert NotYetDueThisMonth(uint8(day), payDayOfMonth);
        }

        uint256 n = _countActive();
        if (n == 0) revert NoActiveRecipients();

        Action[] memory actions = new Action[](n);
        uint256 j;
        for (uint256 i; i < _recipients.length; ++i) {
            Recipient memory r = _recipients[i];
            if (!r.active) continue;
            actions[j++] = (r.token == address(0))
                ? Action({to: r.payee, value: r.amount, data: ""})
                : Action({
                    to: r.token,
                    value: 0,
                    data: abi.encodeCall(IERC20.transfer, (r.payee, r.amount))
                });
        }

        // Set every bit so any single transfer can fail without aborting the run.
        // `n <= MAX_RECIPIENTS = 100`, so the shift never overflows uint256.
        uint256 allowFailureMap = (uint256(1) << n) - 1;

        (, uint256 failureMap) = IExecutor(address(dao())).execute(
            keccak256(abi.encodePacked("PAYROLL:", currentPeriod)),
            actions,
            allowFailureMap
        );

        // Lock the period BEFORE emitting so reentry through a recipient cannot
        // re-enter executePayroll for the same period (defense in depth — the DAO
        // is the executor here, and the crank reads `lastPayoutPeriod` first).
        lastPayoutPeriod = currentPeriod;

        emit PayrollExecuted(currentPeriod, n, failureMap);
    }

    // --- Views ------------------------------------------------------------

    /// @inheritdoc IPayrollPlugin
    function recipientCount() external view override returns (uint256) {
        return _recipients.length;
    }

    /// @inheritdoc IPayrollPlugin
    function getRecipientAt(uint256 index) external view override returns (Recipient memory) {
        return _recipients[index];
    }

    /// @inheritdoc IPayrollPlugin
    function allActiveRecipients() external view override returns (Recipient[] memory) {
        uint256 active = _countActive();
        Recipient[] memory out = new Recipient[](active);
        uint256 j;
        for (uint256 i; i < _recipients.length; ++i) {
            if (_recipients[i].active) {
                out[j++] = _recipients[i];
            }
        }
        return out;
    }

    // --- Internals --------------------------------------------------------

    function _countActive() private view returns (uint256 n) {
        uint256 len = _recipients.length;
        for (uint256 i; i < len; ++i) {
            if (_recipients[i].active) ++n;
        }
    }
}
