// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Morpho Blue's oracle interface, reused verbatim for the price passthrough in LocateRouter.
/// @dev Returns the price of 1 unit of collateral token quoted in 1 unit of loan token, scaled by 1e36
/// (36 + loanDecimals - collateralDecimals decimals of precision). See SPEC.md section 2.
interface IOracle {
    function price() external view returns (uint256);
}
