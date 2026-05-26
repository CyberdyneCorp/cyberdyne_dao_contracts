// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title IAaveAdapter
/// @notice Version-isolating shim between `AaveLendingPlugin` and a concrete
///         AAVE pool (v3, v4, …).
///
/// @dev    CALLDATA-BUILDER pattern. The adapter does NOT forward calls to the
///         pool — instead it returns (a) the pool address and (b) the encoded
///         calldata for each operation against THIS adapter's AAVE version.
///         `AaveLendingPlugin` then has the DAO call the pool DIRECTLY via
///         `IExecutor.execute`, so `msg.sender` at the pool is the DAO.
///
///         This matters because AAVE keys all custody off `msg.sender`:
///           - supply  pulls the asset from msg.sender
///           - withdraw burns the caller's aTokens
///           - borrow  draws against the caller's collateral
///           - repay   pulls the asset from msg.sender
///         If the adapter forwarded the call, msg.sender would be the adapter
///         (which holds nothing) and every op would revert. By having the DAO
///         call the pool directly, the DAO's approvals + aToken/debt balances
///         all resolve correctly. The adapter stays stateless and never
///         touches funds.
///
///         Swapping versions = a DAO vote calling
///         `AaveLendingPlugin.setAdapter(newAdapter)`. No plugin redeploy.
interface IAaveAdapter {
    /// @notice The AAVE Pool the DAO will call directly. Also the approval
    ///         target for supply/repay.
    function poolAddress() external view returns (address);

    /// @notice Calldata for a supply of `amount` `asset`, aTokens to `onBehalfOf`.
    function encodeSupply(
        address asset,
        uint256 amount,
        address onBehalfOf
    ) external view returns (bytes memory);

    /// @notice Calldata for a withdraw of `amount` `asset` to `to`.
    function encodeWithdraw(
        address asset,
        uint256 amount,
        address to
    ) external view returns (bytes memory);

    /// @notice Calldata for a borrow of `amount` `asset`, debt to `onBehalfOf`.
    function encodeBorrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external view returns (bytes memory);

    /// @notice Calldata for a repay of `amount` `asset` for `onBehalfOf`.
    function encodeRepay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external view returns (bytes memory);
}
