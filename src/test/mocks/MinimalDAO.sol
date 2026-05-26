// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {IExecutor, Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

/// @title MinimalDAO — test-only DAO that actually executes Action[].
/// @notice Implements `execute` with real per-action allowFailureMap semantics
///         so tests can verify our plugins' batched flows end-to-end without
///         pulling the full OSx DAO + ENS dependency graph into the build.
/// @dev    Permissions are stored in an open table keyed by `(where, who, permissionId)`.
///         Tests grant whatever they need; auth in our plugins routes through
///         the DAO's `hasPermission`, which reads this table.
contract MinimalDAO is IDAO, IExecutor {
    mapping(bytes32 => bool) internal _perms;

    receive() external payable {
        emit NativeTokenDeposited(msg.sender, msg.value);
    }

    function _key(address where, address who, bytes32 permissionId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(where, who, permissionId));
    }

    function grant(address where, address who, bytes32 permissionId) external {
        _perms[_key(where, who, permissionId)] = true;
    }

    function revoke(address where, address who, bytes32 permissionId) external {
        _perms[_key(where, who, permissionId)] = false;
    }

    function hasPermission(
        address _where,
        address _who,
        bytes32 _permissionId,
        bytes memory /* _data */
    ) external view override returns (bool) {
        return _perms[_key(_where, _who, _permissionId)];
    }

    /// @notice Real execute — mirrors OSx DAO semantics: each action runs in
    ///         order; if a failing action's bit is set in `allowFailureMap` the
    ///         run continues and the corresponding bit lands in `failureMap`.
    function execute(
        bytes32 callId,
        Action[] memory _actions,
        uint256 allowFailureMap
    ) external override returns (bytes[] memory execResults, uint256 failureMap) {
        uint256 n = _actions.length;
        execResults = new bytes[](n);

        for (uint256 i; i < n; ++i) {
            Action memory a = _actions[i];
            (bool ok, bytes memory ret) = a.to.call{value: a.value}(a.data);
            if (!ok) {
                bool allowed = (allowFailureMap >> i) & 1 == 1;
                if (!allowed) {
                    // Bubble up the revert reason if any, otherwise revert with a generic tag.
                    if (ret.length > 0) {
                        assembly {
                            revert(add(ret, 32), mload(ret))
                        }
                    }
                    revert("MinimalDAO: action reverted");
                }
                failureMap |= (uint256(1) << i);
            }
            execResults[i] = ret;
        }

        emit Executed(msg.sender, callId, _actions, allowFailureMap, failureMap, execResults);
    }

    // --- Unused IDAO surface (no-op stubs so the interface stays satisfied) ---

    function setMetadata(bytes calldata _m) external override {(_m);}

    function deposit(address _t, uint256 _a, string calldata _r) external payable override {
        (_t, _a, _r);
    }

    function setTrustedForwarder(address _f) external override {(_f);}

    function getTrustedForwarder() external pure override returns (address) {return address(0);}

    function isValidSignature(bytes32 _h, bytes memory _s) external pure override returns (bytes4) {
        (_h, _s);
        return 0xffffffff;
    }

    function registerStandardCallback(bytes4 _i, bytes4 _c, bytes4 _m) external override {
        (_i, _c, _m);
    }

    function setSignatureValidator(address _v) external override {(_v);}
}
