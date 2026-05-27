// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title ICostRegistryPlugin
/// @notice Vote-gated registry of the DAO's recurring operating costs (AI
///         tokens, cloud bills, services…). Each entry pays a fixed USDC
///         amount to a payee every `frequencyDays`. Mutations are gated on a
///         DAO vote; the `processDue` crank is permissionless; entries are
///         publicly readable with pagination.
interface ICostRegistryPlugin {
    /// @notice A single recurring cost line item.
    /// @dev `active = false` is a soft delete so payout history (events /
    ///      subgraph) keeps a stable foreign key. Packed: payee(20)+costUsdc(12)
    ///      share slot 0; frequencyDays(4)+lastPaidAt(8)+active(1) share slot 1.
    struct CostEntry {
        address payee; // recipient of each recurring payment
        uint96 costUsdc; // amount per payment, in the payment token's smallest unit
        uint32 frequencyDays; // pay every N days
        uint64 lastPaidAt; // unix ts of the last payment (set at registration)
        bool active; // soft-delete flag
        string name; // short label, e.g. "AWS"
        string description; // free-form context
    }

    // --- Events ---

    event EntryRegistered(
        uint256 indexed id,
        address indexed payee,
        uint256 costUsdc,
        uint32 frequencyDays,
        string name
    );
    event EntryUpdated(
        uint256 indexed id,
        address indexed payee,
        uint256 costUsdc,
        uint32 frequencyDays
    );
    event EntryRemoved(uint256 indexed id);
    /// @notice A single entry was paid by the crank.
    event CostPaid(uint256 indexed id, address indexed payee, uint256 amount, uint64 paidAt);
    /// @notice Summary of one `processDue` batch.
    /// @param fromIndex First entry index scanned in this call.
    /// @param count Number of entries actually paid in this batch.
    /// @param failureMap Bitmap of per-entry transfer failures within the batch
    ///        (bit `i` = the `i`-th paid entry's transfer reverted). Page-local.
    event CostsProcessed(uint256 fromIndex, uint256 count, uint256 failureMap);

    // --- Errors ---

    error ZeroAddress();
    error ZeroAmount();
    error ZeroFrequency();
    error EmptyName();
    error EntryNotFound(uint256 id);
    error EntryLimitExceeded(uint256 max);
    error CostTooLarge(uint256 costUsdc);
    error PageSizeZero();

    // --- Vote-gated mutators ---

    /// @notice Register a new recurring cost. First payment becomes due
    ///         `frequencyDays` after registration.
    /// @return id The new entry's index.
    function registerEntry(
        string calldata name,
        string calldata description,
        uint256 costUsdc,
        uint32 frequencyDays,
        address payee
    ) external returns (uint256 id);

    /// @notice Overwrite an entry's fields. Does not reset the payment schedule
    ///         (`lastPaidAt` is preserved).
    function updateEntry(
        uint256 id,
        string calldata name,
        string calldata description,
        uint256 costUsdc,
        uint32 frequencyDays,
        address payee
    ) external;

    /// @notice Soft-delete an entry (kept for history; never paid again).
    function removeEntry(uint256 id) external;

    // --- Permissionless crank ---

    /// @notice Pay every due, active entry in the index window
    ///         `[offset, offset+limit)`. Anyone may call. Idempotent per entry
    ///         via `lastPaidAt`: a re-run only pays entries that have since come
    ///         due. Missed periods are skipped (no back-pay / no stacking).
    function processDue(uint256 offset, uint256 limit) external;

    // --- Views ---

    function paymentToken() external view returns (address);

    function entryCount() external view returns (uint256);

    function getEntry(uint256 id) external view returns (CostEntry memory);

    /// @notice Read a page of entries (active and soft-deleted) plus the total.
    /// @param offset First index to return.
    /// @param limit Max entries to return (clamped to `MAX_PER_PAGE`).
    function getEntries(
        uint256 offset,
        uint256 limit
    ) external view returns (CostEntry[] memory page, uint256 total);

    /// @notice True if entry `id` is active and currently due for payment.
    function isDue(uint256 id) external view returns (bool);

    /// @notice Unix timestamp the entry next becomes payable.
    function nextPaymentAt(uint256 id) external view returns (uint256);

    /// @notice Hard cap on `entryCount()` (active + soft-deleted slots).
    function MAX_ENTRIES() external view returns (uint256);

    /// @notice Max entries paid per `processDue` call (per-tx / 256-bit-bitmap cap).
    function MAX_PER_PAGE() external view returns (uint256);
}
