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
    /// @notice Emitted when governance migrates the registry's payment token.
    ///         All existing entries are re-denominated in the new token
    ///         immediately (their stored `costUsdc` is reused verbatim, so a
    ///         migration to a token with different decimals must be paired with
    ///         entry updates in the same proposal).
    event PaymentTokenUpdated(address indexed previous, address indexed current);
    /// @notice The settable entry-slot cap (`MAX_ENTRIES()`) was changed.
    event MaxEntriesUpdated(uint256 oldMax, uint256 newMax);

    // --- Errors ---

    error ZeroAddress();
    error ZeroAmount();
    error ZeroFrequency();
    error EmptyName();
    error EntryNotFound(uint256 id);
    error EntryLimitExceeded(uint256 max);
    error CostTooLarge(uint256 costUsdc);
    error PageSizeZero();
    /// @notice `setMaxEntries` was called with a value below the current slot
    ///         count or above `MAX_ENTRIES_CEILING`.
    error MaxEntriesOutOfRange(uint256 requested, uint256 minimum, uint256 ceiling);
    /// @notice `processAllDue()` was called on a registry with more than
    ///         `MAX_PER_PAGE` slots, where a single page cannot cover everything.
    ///         Use `processDue` / `processDueFromCursor` to paginate (CR-L-02).
    error RegistryExceedsSinglePage(uint256 maxPerPage);
    /// @notice `setPaymentToken` was called with a token whose `decimals()`
    ///         differs from the current token's. Migrating across decimals would
    ///         silently re-price every entry, so it is rejected (CR-M-02).
    error PaymentTokenDecimalsMismatch(uint8 oldDecimals, uint8 newDecimals);

    // --- Vote-gated mutators ---

    /// @notice Register a new recurring cost. First payment becomes due
    ///         `frequencyDays` after registration.
    /// @dev CR-I-02: duplicate `(payee, name)` pairs are intentionally allowed.
    ///      A vendor commonly bills several recurring lines (e.g. two AWS
    ///      accounts, or one-off retainers on the same name), so a uniqueness
    ///      guard would block legitimate registrations. Each entry has its own
    ///      independent `id` and payment clock; governance review is the control
    ///      against accidental duplicates.
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

    /// @notice Raise or lower the entry-slot cap returned by `MAX_ENTRIES()`.
    ///         Must be ≥ the current slot count and ≤ `MAX_ENTRIES_CEILING`.
    ///         Lets the DAO grow past the default 300 without a plugin upgrade.
    ///         Gated by `MANAGE_COSTS`.
    function setMaxEntries(uint256 newMax) external;

    /// @notice Vote-gated swap of the registry's payment token. Existing entries
    ///         remain valid but are re-denominated in `newToken` from the next
    ///         `processDue`; their stored `costUsdc` is **not** rescaled, so a
    ///         migration to a token with different decimals MUST pair this call
    ///         with `updateEntry` calls in the same proposal.
    function setPaymentToken(address newToken) external;

    // --- Permissionless crank ---

    /// @notice Pay every due, active entry in the index window
    ///         `[offset, offset+limit)`. Anyone may call. Idempotent per entry
    ///         via `lastPaidAt`: a re-run only pays entries that have since come
    ///         due. Missed periods are skipped (no back-pay / no stacking).
    function processDue(uint256 offset, uint256 limit) external;

    /// @notice Convenience crank: pay every due entry from index 0 in one page.
    ///         Reverts `RegistryExceedsSinglePage` if the registry has more than
    ///         `MAX_PER_PAGE` slots, so a partial first-page run can never be
    ///         mistaken for a full sweep. Larger registries must paginate with
    ///         `processDue` or `processDueFromCursor`.
    function processAllDue() external;

    /// @notice Round-robin crank: process the page beginning at the persistent
    ///         due-cursor, then advance the cursor by `limit` (wrapping at the
    ///         end). Repeated permissionless calls cover every entry of a
    ///         multi-page registry without keepers coordinating offsets.
    ///         `limit` is clamped to `MAX_PER_PAGE`.
    function processDueFromCursor(uint256 limit) external;

    // --- Views ---

    function paymentToken() external view returns (address);

    /// @notice The per-instance SafeERC20 shim the crank routes payments through
    ///         (see `SafeTransferHelper`). Deployed at install.
    function transferHelper() external view returns (address);

    /// @notice Current page offset `processDueFromCursor` will resume from.
    function dueCursor() external view returns (uint256);

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

    /// @notice The current cap on `entryCount()` (active + soft-deleted slots).
    ///         Governance-settable via `setMaxEntries`, defaulting to 300, never
    ///         above `MAX_ENTRIES_CEILING`.
    function MAX_ENTRIES() external view returns (uint256);

    /// @notice The hard upper bound `setMaxEntries` can never exceed without a
    ///         plugin upgrade. Exposed for UI introspection.
    function MAX_ENTRIES_CEILING() external view returns (uint256);

    /// @notice Max entries paid per `processDue` call (per-tx / 256-bit-bitmap cap).
    function MAX_PER_PAGE() external view returns (uint256);

    /// @notice Defense-in-depth upper bound on `costUsdc` accepted by
    ///         `registerEntry` / `updateEntry`. Set far above any realistic
    ///         per-payment amount so that typos (extra zeros) trip rather than
    ///         silently passing governance review.
    function MAX_COST_USDC() external view returns (uint256);
}
