// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {PluginUUPSUpgradeable} from "@aragon/osx-commons-contracts/src/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";

import {IPayrollPlugin} from "./IPayrollPlugin.sol";

/// @title PayrollPlugin (P1 stub)
/// @notice Vote-gated management + permissionless monthly crank. Real per-recipient
///         transfers + calendar math land in P2 (BokkyPooBahDateTime vendored there).
contract PayrollPlugin is PluginUUPSUpgradeable, IPayrollPlugin {
    bytes32 public constant MANAGE_PAYROLL_PERMISSION_ID = keccak256("MANAGE_PAYROLL_PERMISSION");

    Recipient[] private _recipients;
    /// @dev 1-based index into `_recipients`; 0 = absent. Lets us treat 0 as a sentinel
    ///      without losing slot 0 in the array.
    mapping(address => uint256) public indexOfPayee;

    uint8 public override payDayOfMonth;
    uint256 public override lastPayoutPeriod;

    uint256[47] private __gap;

    function initialize(IDAO _dao, uint8 _payDayOfMonth) external initializer {
        __PluginUUPSUpgradeable_init(_dao);
        if (_payDayOfMonth == 0 || _payDayOfMonth > 28) {
            revert InvalidPayDayOfMonth(_payDayOfMonth);
        }
        payDayOfMonth = _payDayOfMonth;
    }

    function addRecipient(
        address /* payee */,
        address /* token */,
        uint256 /* amount */
    ) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        revert NotImplemented();
    }

    function removeRecipient(address /* payee */) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        revert NotImplemented();
    }

    function setAmount(
        address /* payee */,
        uint256 /* newAmount */
    ) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        revert NotImplemented();
    }

    function setPayDayOfMonth(uint8 day) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        if (day == 0 || day > 28) revert InvalidPayDayOfMonth(day);
        uint8 previous = payDayOfMonth;
        payDayOfMonth = day;
        emit PayDayUpdated(previous, day);
    }

    function executePayroll() external override {
        // P2 will: compute current period, guard against double-pay, build Action[],
        // call dao.execute with allow-failure bits set so one bad recipient doesn't halt others.
        revert NotImplemented();
    }

    function recipientCount() external view override returns (uint256) {
        return _recipients.length;
    }

    function allActiveRecipients() external view override returns (Recipient[] memory) {
        uint256 active;
        for (uint256 i; i < _recipients.length; ++i) {
            if (_recipients[i].active) active++;
        }
        Recipient[] memory out = new Recipient[](active);
        uint256 j;
        for (uint256 i; i < _recipients.length; ++i) {
            if (_recipients[i].active) {
                out[j++] = _recipients[i];
            }
        }
        return out;
    }
}
