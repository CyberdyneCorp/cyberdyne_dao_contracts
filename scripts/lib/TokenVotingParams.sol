// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title TokenVotingParams
/// @notice Typed construction of the `_data` payload that
///         `TokenVotingSetup.prepareInstallation(dao, data)` decodes, plus
///         sane defaults. Replaces passing raw pre-encoded bytes.
///
/// @dev    Schema verified against the TokenVoting ABIs vendored at
///         `lib/osx-commons/artifacts/src/abis/token-voting-plugin-abis.ts`
///         (the build matching our pinned OSx 1.4.x). For this build the
///         setup decodes `_data` as:
///             abi.encode(VotingSettings, TokenSettings, MintSettings)
///
///         VotingSettings — MajorityVotingBase.VotingSettings
///         TokenSettings  — TokenVotingSetup.TokenSettings (mint fresh if addr == 0)
///         MintSettings   — GovernanceERC20.MintSettings
///
/// > [!] If you target a chain whose TokenVoting PluginRepo pins a DIFFERENT
///       build (e.g. a newer build that added TargetConfig / minApprovals),
///       this encoding will NOT match its decoder and the install tx will
///       revert. Verify the deployed build before mainnet — see
///       `docs/plugins`/the Deployment doc.
library TokenVotingParams {
    /// @dev MajorityVotingBase.VotingMode enum.
    enum VotingMode {
        Standard, // 0 — vote, then a separate execute tx
        EarlyExecution, // 1 — execute as soon as the outcome is irreversible
        VoteReplacement // 2 — voters can change their vote while open
    }

    /// @dev MajorityVotingBase.VotingSettings.
    struct VotingSettings {
        uint8 votingMode; // cast from VotingMode
        uint32 supportThreshold; // ppm (1e6 = 100%); e.g. 500000 = 50%
        uint32 minParticipation; // ppm; e.g. 100000 = 10%
        uint64 minDuration; // seconds; OSx floor is 1 hour
        uint256 minProposerVotingPower; // tokens needed to create a proposal
    }

    /// @dev TokenVotingSetup.TokenSettings. `addr == address(0)` => mint a
    ///      fresh GovernanceERC20 named (name, symbol).
    struct TokenSettings {
        address addr;
        string name;
        string symbol;
    }

    /// @dev GovernanceERC20.MintSettings — genesis allocation.
    struct MintSettings {
        address[] receivers;
        uint256[] amounts;
    }

    /// @notice ABI-encode the three structs into the `_data` payload.
    function encodeInstallData(
        VotingSettings memory voting,
        TokenSettings memory token,
        MintSettings memory mint
    ) internal pure returns (bytes memory) {
        return abi.encode(voting, token, mint);
    }

    /// @notice Permissive defaults intended for TESTNET iteration only.
    ///         50% support, 10% participation, 1-hour minimum duration,
    ///         1-token proposer floor, Standard voting mode.
    /// @dev    Mainnet MUST override with real durations + participation
    ///         floors. See the Governance Token Spec note in the vault.
    function defaultTestnetVotingSettings() internal pure returns (VotingSettings memory) {
        return
            VotingSettings({
                votingMode: uint8(VotingMode.Standard),
                supportThreshold: 500000, // 50%
                minParticipation: 100000, // 10%
                minDuration: 1 hours,
                minProposerVotingPower: 1e18 // 1 token
            });
    }
}
