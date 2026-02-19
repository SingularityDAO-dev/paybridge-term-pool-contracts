// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {TermVault} from "./TermVault.sol";
import {TermPositionNFT} from "./TermPositionNFT.sol";

contract TermVaultFactory {
    event VaultCreated(
        address indexed vault,
        address indexed positionNFT,
        address indexed asset,
        uint256[] termDurations,
        address admin
    );

    address[] public allVaults;
    mapping(address => bool) public isVault;

    function createVault(
        address asset,
        uint256[] calldata termDurations,
        uint256[] calldata termAPYs,
        uint256 depositCap,
        uint256 minDeposit,
        address admin
    ) external returns (address vault, address positionNFT) {
        string memory name = string(abi.encodePacked("TERM Position - ", _toAsciiString(asset)));

        positionNFT = address(new TermPositionNFT(name, "TERM-POS"));

        vault = address(new TermVault(
            asset,
            positionNFT,
            termDurations,
            termAPYs,
            depositCap,
            minDeposit,
            admin
        ));

        TermPositionNFT(positionNFT).authorizeVault(vault, true);

        allVaults.push(vault);
        isVault[vault] = true;

        emit VaultCreated(vault, positionNFT, asset, termDurations, admin);
    }

    function getVaultCount() external view returns (uint256) {
        return allVaults.length;
    }

    function getAllVaults() external view returns (address[] memory) {
        return allVaults;
    }

    function _toAsciiString(address x) internal pure returns (string memory) {
        bytes memory s = new bytes(40);
        for (uint i = 0; i < 20; i++) {
            bytes1 b = bytes1(uint8(uint(uint160(x)) / (2**(8*(19 - i)))));
            bytes1 hi = bytes1(uint8(b) / 16);
            bytes1 lo = bytes1(uint8(b) - 16 * uint8(hi));
            s[2*i] = _char(hi);
            s[2*i+1] = _char(lo);
        }
        return string(s);
    }

    function _char(bytes1 b) internal pure returns (bytes1 c) {
        if (uint8(b) < 10) return bytes1(uint8(b) + 0x30);
        else return bytes1(uint8(b) + 0x57);
    }
}
