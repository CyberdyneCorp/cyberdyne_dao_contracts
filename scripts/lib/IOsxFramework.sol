// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IPluginSetup} from "@aragon/osx-commons-contracts/src/plugin/setup/IPluginSetup.sol";

/// @dev Forward-declared interfaces for OSx framework contracts the bootstrap
///      consumes. Avoids pulling the full `lib/osx/packages/contracts/src/...`
///      tree (which transitively imports @ensdomains/ens-contracts) into our
///      compile. Same isolation pattern we use for IUniversalRouter / IPermit2.

/// @notice Subset of `aragon/osx` PluginRepo we need (just an opaque address holder).
interface IPluginRepo {}

/// @notice Subset of `PluginRepoFactory.createPluginRepoWithFirstVersion`.
interface IPluginRepoFactory {
    function createPluginRepoWithFirstVersion(
        string calldata subdomain,
        address pluginSetup,
        address maintainer,
        bytes memory releaseMetadata,
        bytes memory buildMetadata
    ) external returns (IPluginRepo pluginRepo);
}

/// @notice `PluginRepo.Tag` — release+build pair identifying a plugin version.
struct Tag {
    uint8 release;
    uint16 build;
}

/// @notice `PluginSetupRef` from PluginSetupProcessorHelpers.
struct PluginSetupRef {
    Tag versionTag;
    IPluginRepo pluginSetupRepo;
}

/// @notice Subset of `DAOFactory` we need to call.
interface IDAOFactory {
    struct DAOSettings {
        address trustedForwarder;
        string daoURI;
        string subdomain;
        bytes metadata;
    }

    struct PluginSettings {
        PluginSetupRef pluginSetupRef;
        bytes data;
    }

    struct InstalledPlugin {
        address plugin;
        IPluginSetup.PreparedSetupData preparedSetupData;
    }

    function createDao(
        DAOSettings calldata daoSettings,
        PluginSettings[] calldata pluginSettings
    ) external returns (address createdDao, InstalledPlugin[] memory installedPlugins);
}

/// @notice Subset of OSx core DAO — what we call from scripts post-bootstrap.
interface IDAOLite {
    function hasPermission(
        address where,
        address who,
        bytes32 permissionId,
        bytes memory data
    ) external view returns (bool);
}

/// @notice Subset of `IProtocolVersion` — fail-fast assertion at bootstrap.
interface IProtocolVersionLite {
    function protocolVersion() external view returns (uint8[3] memory);
}
