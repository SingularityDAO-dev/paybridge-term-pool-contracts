// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ITermVault, IYieldDistributor} from "./interfaces/ITermPool.sol";

contract YieldDistributor is IYieldDistributor, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant INJECTOR_ROLE = keccak256("INJECTOR_ROLE");

    IERC20 public immutable asset;
    ITermVault public vault;

    InjectionRecord[] public injectionHistory;

    event YieldInjected(
        uint256 amount,
        bytes32 attestationHash,
        uint256 timestamp,
        address indexed caller
    );

    event VaultUpdated(address oldVault, address newVault);

    error ZeroAmount();
    error InvalidVault();

    constructor(address _asset, address _vault, address admin) {
        if (_asset == address(0)) revert InvalidVault();
        if (_vault == address(0)) revert InvalidVault();

        asset = IERC20(_asset);
        vault = ITermVault(_vault);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(INJECTOR_ROLE, admin);
    }

    function injectYield(uint256 amount, bytes32 attestationHash) external onlyRole(INJECTOR_ROLE) {
        if (amount == 0) revert ZeroAmount();

        asset.safeTransferFrom(msg.sender, address(this), amount);
        asset.approve(address(vault), amount);
        vault.recordYieldInjection(amount);

        injectionHistory.push(InjectionRecord({
            timestamp: block.timestamp,
            amount: amount,
            attestationHash: attestationHash,
            caller: msg.sender
        }));

        emit YieldInjected(amount, attestationHash, block.timestamp, msg.sender);
    }

    function setVault(address _newVault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_newVault == address(0)) revert InvalidVault();

        address oldVault = address(vault);
        vault = ITermVault(_newVault);

        emit VaultUpdated(oldVault, _newVault);
    }

    function getInjectionHistory() external view returns (InjectionRecord[] memory) {
        return injectionHistory;
    }

    function getInjectionCount() external view returns (uint256) {
        return injectionHistory.length;
    }

    function getLatestInjection() external view returns (InjectionRecord memory) {
        require(injectionHistory.length > 0, "No injections");
        return injectionHistory[injectionHistory.length - 1];
    }
}
