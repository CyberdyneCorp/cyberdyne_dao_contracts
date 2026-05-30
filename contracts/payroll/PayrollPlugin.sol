solidity
// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.21;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PluginUUPSUpgradeable} from "@aragon/osx/core/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx/core/dao/IDAO.sol";

/// @title PayrollPlugin
/// @notice Manages recurring token salaries for DAO contributors with bounties, structured pagination, and safe accounting.
/// @dev Implements audit‑mandated fixes: atomic payment‑and‑marking, double‑pay guard, snapshot immutability,
///      recipient reactivation, and comprehensive events.
contract PayrollPlugin is PluginUUPSUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ════════════════════════════════════════════════════════════════════════
    //  Custom Errors (gas‑efficient, replaces strings)
    // ═════════════════���══════════════════════════════════════════════════════

    /// @dev The provided address is the zero address.
    error InvalidAddress();

    /// @dev Salary amount must be greater than zero.
    error ZeroSalary();

    /// @dev Recipient is already registered.
    error RecipientAlreadyExists();

    /// @dev Recipient does not exist in the registry.
    error RecipientNotFound();

    /// @dev Recipient is already active.
    error AlreadyActive();

    /// @dev Recipient is not active.
    error NotActive();

    /// @dev Bounty basis points exceed the maximum allowed.
    error BountyBpsExceedsMax(uint256 maxBps, uint256 provided);

    /// @dev Bounty cap is zero but cap required for active bounty.
    error BountyCapZero();

    /// @dev Page size exceeds maximum allowed.
    error PageSizeExceedsMax(uint256 maxPage, uint256 provided);

    /// @dev Snapshot already exists and has not been consumed.
    error SnapshotAlreadyExists();

    /// @dev Snapshot does not exist.
    error SnapshotDoesNotExist();

    /// @dev Snapshot has already been consumed.
    error SnapshotAlreadyConsumed();

    /// @dev Index out of bounds for snapshot array.
    error IndexOutOfBounds();

    /// @dev Force‑pay block guard triggered; recipient already force paid in this block.
    error ForcePayGuardActive();

    /// @dev Transfer of tokens failed.
    error TransferFailed();

    /// @dev Arithmetic overflow or underflow detected (safety catch).
    error SafeCastOverflow();

    /// @dev The provided token address is the zero address.
    error InvalidToken();

    /// @dev Snapshot was taken with no active recipients.
    error NoActiveRecipients();

    /// @dev Salary token does not match the contract's salary token.
    error WrongSalaryToken();

    /// @dev The referrer is the same as the recipient.
    error ReferrerEqualsRecipient();

    /// @dev Caller does not have the required permission.
    error Unauthorized(address caller, bytes32 permissionId);

    /// @dev Inconsistent state: snapshot index array length mismatch.
    error SnapshotCorrupted();

    /// @dev Indices array is empty.
    error EmptyIndicesArray();

    /// @dev Attempted to consume snapshot with remaining unprocessed recipients.
    error SnapshotNotFullyConsumed();

    // ════════════════════════════════════════════════════════════════════════
    //  Constants
    // ════════════════════════════════════════════════════════════════════════

    /// @notice maximum bounty basis points (5 % = 500)
    uint256 public constant MAX_BOUNTY_BPS = 500;

    /// @notice maximum recipients processed in a single paginated chunk
    uint256 public constant MAX_PAGE_SIZE = 200;

    /// @notice permission identifier forwarded to the DAO’s ACL
    bytes32 public constant EXECUTE_PAYROLL_PERMISSION_ID = keccak256("EXECUTE_PAYROLL");

    // ════════════════════════════════════════════════════════════════════════
    //  Types
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Full recipient data stored in the dynamic array.
    struct Recipient {
        address account;
        uint128 salary; // tokens per second (scaled to avoid precision loss)
        bool active;
    }

    /// @notice Bounty paid to the referrer of a recipient.
    struct BountyConfig {
        uint16 bountyBps; // basis points (0 = 0 %, 500 = 5 %)
        uint128 cap;      // maximum bounty per payment (0 = no cap)
        bool active;
    }

    /// @notice Immutable snapshot of active recipient indices taken when a payroll run starts.
    struct PayrollSnapshot {
        uint64 runId;
        uint40 timestamp;
        uint256[] indices; // recipient indices that were active at snapshot time
        bool consumed;     // true after the run finishes
    }

    // ════════════════════════════════════════════════════════════════════════
    //  State
    // ════════════════════════════════════════════════════════════════════════

    IERC20 public salaryToken; // token used for salary payments
    address public treasury;   // fallback address for undirected funds

    /// @dev Dynamic array of all recipients (never deleted, only deactivated).
    Recipient[] private _recipients;

    /// @dev recipient → (index + 1), 0 sentinel = not registered
    mapping(address => uint256) private _recipientIndexMap;

    /// @dev recipient index → last timestamp salary was paid
    mapping(uint256 => uint40) private _lastPaidAt;

    /// @dev token → bounty configuration
    mapping(address => BountyConfig) private _bountyConfig;

    /// @dev recipient index → referrer (optional, zero address allowed)
    mapping(uint256 => address) private _referrer;

    /// @dev payroll run id counter, increments with each snapshot
    uint64 private _nextRunId;

    /// @dev current (or latest finished) snapshot; only one active at a time
    PayrollSnapshot private _currentSnapshot;

    /// @dev force‑pay guard (block‑level, sufficient when combined with nonReentrant)
    mapping(address => uint256) private _lastForcePayBlock;

    /// @dev gap for future upgrades (reserved storage slots)
    uint256[50] private __gap;

    // ════════════════════════════════════════════════════════════════════════
    //  Events (equivalent to logging with severity inferred from event name)
    // ════════════════════════════════════════════════════════════════════════

    /// @notice CRITICAL: payroll execution failed due to transfer revert.
    /// @param recipient Recipient address
    /// @param amount attempted transfer amount
    /// @param reason reason from SafeERC20 revert
    event PayrollTransferFailed(address indexed recipient, uint256 amount, string reason);

    /// @notice Emitted when a new recipient is added.
    /// @param account Recipient address
    /// @param index Assigned index in the _recipients array
    /// @param salary Salary per second (tokens/second)
    /// @param referrer Referrer address, zero if unknown
    event RecipientAdded(
        address indexed account,
        uint256 indexed index,
        uint256 salary,
        address referrer
    );

    /// @notice Emitted when a recipient's salary is updated.
    /// @param account Recipient address
    /// @param newSalary New salary per second
    event RecipientUpdated(address indexed account, uint256 newSalary);

    /// @notice Emitted when a recipient is activated.
    /// @param account Recipient address
    event RecipientActivated(address indexed account);

    /// @notice Emitted when a recipient is deactivated.
    /// @param account Recipient address
    event RecipientDeactivated(address indexed account);

    /// @notice Emitted when a bounty configuration is changed.
    /// @param token Token address for which bounty is configured
    /// @param bountyBps Basis points of bounty
    /// @param cap Maximum bounty amount per payment
    /// @param active Whether bounty is active
    event BountyConfigUpdated(
        address indexed token,
        uint256 bountyBps,
        uint256 cap,
        bool active
    );

    /// @notice Emitted when a payroll snapshot is taken.
    /// @param runId New run identifier
    /// @param recipientCount Number of active recipients at snapshot time
    /// @param timestamp Block timestamp of snapshot
    event PayrollSnapshotTaken(
        uint64 indexed runId,
        uint256 recipientCount,
        uint40 timestamp
    );

    /// @notice Emitted after each chunk of a payroll run.
    /// @param runId Run identifier
    /// @param fromIndex Inclusive start in the snapshot index array
    /// @param toIndex Exclusive end
    /// @param totalPaid Sum of salary amounts transferred
    /// @param isFinal Whether this chunk completed the run
    event PayrollExecuted(
        uint64 indexed runId,
        uint256 fromIndex,
        uint256 toIndex,
        uint256 totalPaid,
        bool isFinal
    );

    /// @notice Emitted when an individual salary payment is made.
    /// @param runId Run identifier
    /// @param recipient Recipient address
    /// @param salaryAmount Amount paid
    /// @param bountyAmount Bounty paid to referrer
    event SalaryPaid(
        uint64 indexed runId,
        address indexed recipient,
        uint256 salaryAmount,
        uint256 bountyAmount
    );

    /// @notice Emitted when a force pay occurs.
    /// @param recipient Recipient address
    /// @param amount Amount paid
    /// @param reason Reason for force pay
    event ForcePayExecuted(
        address indexed recipient,
        uint256 amount,
        string reason
    );

    // ════════════════════════════════════════════════════════════════════════
    //  Modifiers
    // ════════════════════════════════════════════════════════════════════════

    /// @dev Check that salary token is set (initialized).
    modifier onlyInitialized() {
        if (address(salaryToken) == address(0)) revert InvalidToken();
        _;
    }

    /// @dev Verify recipient index exists and is active.
    modifier activeRecipient(uint256 index) {
        if (index >= _recipients.length) revert RecipientNotFound();
        if (!_recipients[index].active) revert NotActive();
        _;
    }

    // ═══���════════════════════════════════════════════════════════════════════
    //  Initializer (replaces constructor for upgradeable contract)
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Initializes the plugin with DAO, token, and treasury.
    /// @param _dao The DAO that owns this plugin
    /// @param _salaryToken ERC20 token used for payments
    /// @param _treasury Fallback address for undirected bounty funds
    function initialize(
        IDAO _dao,
        IERC20 _salaryToken,
        address _treasury
    ) external initializer {
        if (address(_salaryToken) == address(0)) revert InvalidToken();
        if (_treasury == address(0)) revert InvalidAddress();

        __PluginUUPSUpgradeable_init(_dao);
        __ReentrancyGuard_init();

        salaryToken = _salaryToken;
        treasury = _treasury;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  External Write Functions
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Adds a new recipient with specified salary and optional referrer.
    /// @param _account Recipient address
    /// @param _salary Salary per second (in token wei)
    /// @param _referrerAddress Referrer address (zero allowed)
    /// @return index Assigned index in recipients array
    function addRecipient(
        address _account,
        uint128 _salary,
        address _referrerAddress
    ) external auth(EXECUTE_PAYROLL_PERMISSION_ID) returns (uint256 index) {
        if (_account == address(0)) revert InvalidAddress();
        if (_salary == 0) revert ZeroSalary();
        if (_recipientIndexMap[_account] != 0) revert RecipientAlreadyExists();
        if (_account == _referrerAddress) revert ReferrerEqualsRecipient();

        index = _recipients.length;
        _recipients.push(Recipient({account: _account, salary: _salary, active: true}));
        _recipientIndexMap[_account] = index + 1;
        _lastPaidAt[index] = uint40(block.timestamp);
        if (_referrerAddress != address(0)) {
            _referrer[index] = _referrerAddress;
        }
        emit RecipientAdded(_account, index, _salary, _referrerAddress);
    }

    /// @notice Updates the salary of an existing recipient.
    /// @param _account Recipient address
    /// @param _newSalary New salary per second
    function updateSalary(
        address _account,
        uint128 _newSalary
    ) external auth(EXECUTE_PAYROLL_PERMISSION_ID) {
        uint256 index = _getIndex(_account);
        if (_newSalary == 0) revert ZeroSalary();
        _recipients[index].salary = _newSalary;
        emit RecipientUpdated(_account, _newSalary);
    }

    /// @notice Activates a currently inactive recipient.
    /// @param _account Recipient address
    function activateRecipient(address _account) external auth(EXECUTE_PAYROLL_PERMISSION_ID) {
        uint256 index = _getIndex(_account);
        if (_recipients[index].active) revert AlreadyActive();
        _recipients[index].active = true;
        _lastPaidAt[index] = uint40(block.timestamp);
        emit RecipientActivated(_account);
    }

    /// @notice Deactivates a currently active recipient.
    /// @param _account Recipient address
    function deactivateRecipient(address _account) external auth(EXECUTE_PAYROLL_PERMISSION_ID) {
        uint256 index = _getIndex(_account);
        if (!_recipients[index].active) revert NotActive();
        _recipients[index].active = false;
        emit RecipientDeactivated(_account);
    }

    /// @notice Sets or updates the bounty configuration for a token.
    /// @param _token Token address
    /// @param _bountyBps Basis points of bounty (max 500)
    /// @param _cap Maximum bounty per payment (0 = no cap)
    /// @param _active Whether bounty is active
    function setBountyConfig(
        address _token,
        uint16 _bountyBps,
        uint128 _cap,
        bool _active
    ) external auth(EXECUTE_PAYROLL_PERMISSION_ID) {
        if (_token == address(0)) revert InvalidToken();
        if (_bountyBps > MAX_BOUNTY_BPS) revert BountyBpsExceedsMax(MAX_BOUNTY_BPS, _bountyBps);
        if (_active && _cap == 0) revert BountyCapZero();
        _bountyConfig[_token] = BountyConfig({bountyBps: _bountyBps, cap: _cap, active: _active});
        emit BountyConfigUpdated(_token, _bountyBps, _cap, _active);
    }

    /// @notice Takes a snapshot of all currently active recipients, starting a new payroll run.
    /// @dev Only one snapshot can exist at a time. Must be consumed before another snapshot.
    function takeSnapshot() external auth(EXECUTE_PAYROLL_PERMISSION_ID) onlyInitialized {
        if (!_currentSnapshot.consumed && _currentSnapshot.indices.length > 0) {
            revert SnapshotAlreadyExists();
        }
        uint256 len = _recipients.length;
        uint256 count;
        // First pass: count active recipients
        for (uint256 i = 0; i < len; i++) {
            if (_recipients[i].active) {
                count++;
            }
        }
        if (count == 0) revert NoActiveRecipients();

        // Allocate array and fill
        uint256[] memory indices = new uint256[](count);
        uint256 j;
        for (uint256 i = 0; i < len; i++) {
            if (_recipients[i].active) {
                indices[j++] = i;
            }
        }

        uint64 runId = _nextRunId++;
        uint40 timestamp = uint40(block.timestamp);

        _currentSnapshot = PayrollSnapshot({
            runId: runId,
            timestamp: timestamp,
            indices: indices,
            consumed: false
        });

        emit PayrollSnapshotTaken(runId, count, timestamp);
    }

    /// @notice Processes a chunk of the current payroll snapshot.
    /// @param _fromIndex Start index in the snapshot indices array (inclusive)
    /// @param _size Number of recipients to process in this chunk
    /// @return toIndex Next index to start from (or length if final)
    function executePayrollChunk(
        uint256 _fromIndex,
        uint256 _size
    ) external auth(EXECUTE_PAYROLL_PERMISSION_ID) nonReentrant onlyInitialized returns (uint256 toIndex) {
        if (_currentSnapshot.consumed) revert SnapshotAlreadyConsumed();
        if (_fromIndex >= _currentSnapshot.indices.length) revert IndexOutOfBounds();
        if (_size > MAX_PAGE_SIZE) revert PageSizeExceedsMax(MAX_PAGE_SIZE, _size);

        uint256[] storage snapIndices = _currentSnapshot.indices;
        uint256 totalPaid;
        uint256 endIndex = _fromIndex + _size;
        if (endIndex > snapIndices.length) {
            endIndex = snapIndices.length;
        }

        for (uint256 i = _fromIndex; i < endIndex; i++) {
            uint256 idx = snapIndices[i];
            Recipient storage r = _recipients[idx];
            // Calculate accrued salary since last payment
            uint256 timeElapsed = block.timestamp - _lastPaidAt[idx];
            uint256 salaryAmount = uint256(r.salary) * timeElapsed;

            if (salaryAmount == 0) continue; // skip if nothing due

            // Update last paid timestamp BEFORE transfer (CEI pattern)
            _lastPaidAt[idx] = uint40(block.timestamp);

            // Transfer salary to recipient
            salaryToken.safeTransfer(r.account, salaryAmount);

            uint256 bountyAmount;
            // Handle bounty to referrer
            address referrer = _referrer[idx];
            if (referrer != address(0)) {
                BountyConfig storage bounty = _bountyConfig[address(salaryToken)];
                if (bounty.active) {
                    bountyAmount = (salaryAmount * bounty.bountyBps) / 10000;
                    if (bounty.cap != 0 && bountyAmount > bounty.cap) {
                        bountyAmount = bounty.cap;
                    }
                    if (bountyAmount > 0) {
                        salaryToken.safeTransfer(referrer, bountyAmount);
                    }
                }
            }

            totalPaid += salaryAmount;
            emit SalaryPaid(_currentSnapshot.runId, r.account, salaryAmount, bountyAmount);
        }

        bool isFinal = (endIndex == snapIndices.length);
        if (isFinal) {
            _currentSnapshot.consumed = true;
        }

        emit PayrollExecuted(_currentSnapshot.runId, _fromIndex, endIndex, totalPaid, isFinal);
        return endIndex;
    }

    /// @notice Force pays a specific recipient, bypassing snapshot, under emergency conditions.
    /// @param _account Recipient address
    /// @param _amount Amount to force pay
    /// @param _reason Reason for force pay (max 64 chars)
    function forcePay(
        address _account,
        uint128 _amount,
        string calldata _reason
    ) external auth(EXECUTE_PAYROLL_PERMISSION_ID) nonReentrant onlyInitialized {
        if (_amount == 0) revert ZeroSalary();
        uint256 index = _getIndex(_account);
        if (_lastForcePayBlock[_account] == block.number) revert ForcePayGuardActive();

        // Update last paid timestamp and force pay block
        _lastPaidAt[index] = uint40(block.timestamp);
        _lastForcePayBlock[_account] = block.number;

        salaryToken.safeTransfer(_account, _amount);

        emit ForcePayExecuted(_account, _amount, _reason);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  External View Functions
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Returns the recipient count (including inactive).
    /// @return count Total number of recipients
    function recipientCount() external view returns (uint256) {
        return _recipients.length;
    }

    /// @notice Returns the recipient data by index.
    /// @param _index Index in recipients array
    /// @return account Recipient address
    /// @return salary Salary per second
    /// @return active Whether recipient is active
    function getRecipient(uint256 _index) external view returns (address account, uint256 salary, bool active) {
        if (_index >= _recipients.length) revert IndexOutOfBounds();
        Recipient storage r = _recipients[_index];
        return (r.account, r.salary, r.active);
    }

    /// @notice Returns the index of a recipient address.
    /// @param _account Recipient address
    /// @return index Index (0 if not registered)
    function getRecipientIndex(address _account) external view returns (uint256) {
        uint256 raw = _recipientIndexMap[_account];
        if (raw == 0) return 0;
        return raw - 1;
    }

    /// @notice Returns the last paid timestamp for a recipient.
    /// @param _account Recipient address
    /// @return timestamp Last time salary was paid
    function lastPaidAt(address _account) external view returns (uint40) {
        uint256 index = _getIndex(_account);
        return _lastPaidAt[index];
    }

    /// @notice Returns the bounty configuration for a token.
    /// @param _token Token address
    /// @return bountyBps Basis points
    /// @return cap Maximum bounty per payment
    /// @return active Whether bounty is active
    function getBountyConfig(address _token) external view returns (uint256 bountyBps, uint256 cap, bool active) {
        BountyConfig storage b = _bountyConfig[_token];
        return (b.bountyBps, b.cap, b.active);
    }

    /// @notice Returns the referrer for a recipient.
    /// @param _account Recipient address
    /// @return referrer Referrer address (zero if none)
    function getReferrer(address _account) external view returns (address) {
        uint256 index = _getIndex(_account);
        return _referrer[index];
    }

    /// @notice Returns current snapshot details.
    /// @return runId Run identifier
    /// @return timestamp Snapshot block timestamp
    /// @return consumed Whether snapshot has been fully consumed
    /// @return indicesLength Number of indices in snapshot
    function getCurrentSnapshot()
        external
        view
        returns (uint64 runId, uint40 timestamp, bool consumed, uint256 indicesLength)
    {
        PayrollSnapshot storage snap = _currentSnapshot;
        return (snap.runId, snap.timestamp, snap.consumed, snap.indices.length);
    }

    /// @notice Returns a slice of snapshot indices for pagination display.
    /// @param _offset Start index
    /// @param _limit Number of indices to return
    /// @return indicesSlice Array of recipient indices
    function getSnapshotIndicesSlice(
        uint256 _offset,
        uint256 _limit
    ) external view returns (uint256[] memory indicesSlice) {
        uint256 len = _currentSnapshot.indices.length;
        if (_offset >= len) return new uint256[](0);
        if (_limit > MAX_PAGE_SIZE) revert PageSizeExceedsMax(MAX_PAGE_SIZE, _limit);
        uint256 end = _offset + _limit;
        if (end > len) end = len;
        indicesSlice = new uint256[](end - _offset);
        for (uint256 i = _offset; i < end; i++) {
            indicesSlice[i - _offset] = _currentSnapshot.indices[i];
        }
    }

    /// @notice Returns all recipients in a paginated manner.
    /// @param _offset Start index
    /// @param _limit Number of recipients to return
    /// @return accounts Array of recipient addresses
    /// @return salaries Array of salary per second
    /// @return actives Array of active status
    function getRecipientsPaginated(
        uint256 _offset,
        uint256 _limit
    ) external view returns (address[] memory accounts, uint256[] memory salaries, bool[] memory actives) {
        uint256 total = _recipients.length;
        if (_offset >= total) {
            return (new address[](0), new uint256[](0), new bool[](0));
        }
        if (_limit > MAX_PAGE_SIZE) revert PageSizeExceedsMax(MAX_PAGE_SIZE, _limit);
        uint256 end = _offset + _limit;
        if (end > total) end = total;
        uint256 count = end - _offset;
        accounts = new address[](count);
        salaries = new uint256[](count);
        actives = new bool[](count);
        for (uint256 i = 0; i < count; i++) {
            Recipient storage r = _recipients[_offset + i];
            accounts[i] = r.account;
            salaries[i] = r.salary;
            actives[i] = r.active;
        }
    }

    /// @notice Computes the due salary for a recipient since last payment.
    /// @param _account Recipient address
    /// @return amount Amount due in tokens (wei)
    function getDueSalary(address _account) external view returns (uint256 amount) {
        uint256 index = _getIndex(_account);
        uint256 timeElapsed = block.timestamp - _lastPaidAt[index];
        return uint256(_recipients[index].salary) * timeElapsed;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Internal / Private Functions
    // ════════════════════════════════════════════════════════════════════════

    /// @dev Retrieves the storage index for a recipient address, reverts if not found.
    function _getIndex(address _account) private view returns (uint256) {
        uint256 raw = _recipientIndexMap[_account];
        if (raw == 0) revert RecipientNotFound();
        return raw - 1;
    }
}