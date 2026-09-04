// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Market identifier, `keccak256(abi.encode(MarketParams))`. A user-defined value type wrapping
/// `bytes32`; ABI-encodes identically to `bytes32`, so it is wire-compatible with the real Morpho Blue
/// deployment even though this file declares its own copy of the type (Solidity erases UDVTs to their
/// underlying type at the ABI boundary — this is the same pattern MetaMorpho itself uses).
type Id is bytes32;

/// @notice The five parameters that identify a Morpho Blue market. Field order and types must match
/// Morpho Blue's own `MarketParams` exactly: the id is `keccak256` of this struct's 160-byte memory
/// layout (see `MarketParamsLib.id` in Morpho Blue), so any mismatch in order or type would silently
/// compute a different id than the real contract.
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @title IMorpho
/// @notice The slice of Morpho Blue's external surface that LocateVault and LocateRouter call. Trimmed to
/// exactly what we use (see SPEC.md section 2) rather than importing the vendored test copy, so production
/// contracts never depend on `locate/test/**`.
interface IMorpho {
    function supply(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256 assetsSupplied, uint256 sharesSupplied);

    function withdraw(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);

    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;

    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external;

    function borrow(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

    function repay(MarketParams memory marketParams, uint256 assets, uint256 shares, address onBehalf, bytes memory data)
        external
        returns (uint256 assetsRepaid, uint256 sharesRepaid);

    function accrueInterest(MarketParams memory marketParams) external;

    function position(Id id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    function market(Id id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );
}
