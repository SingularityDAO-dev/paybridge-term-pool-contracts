// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface ITermVault {
    function deposit(uint256 amount, uint256 termIndex, address receiver) external returns (uint256);
    function withdraw(uint256 positionId) external returns (uint256);
    function recordYieldInjection(uint256 amount) external;
    function totalPrincipal() external view returns (uint256);
    function totalAccruedYield() external view returns (uint256);
    function asset() external view returns (address);
    function calculateYield(uint256 principal, uint256 apyBps, uint256 termSeconds) external pure returns (uint256);
}

interface ITermPositionNFT {
    struct Position {
        uint256 principal;
        uint256 depositTimestamp;
        uint256 maturityTimestamp;
        uint256 termDuration;
        uint256 apyAtDeposit;
        address vault;
        bool redeemed;
    }

    function mint(
        address to,
        uint256 principal,
        uint256 depositTimestamp,
        uint256 maturityTimestamp,
        uint256 termDuration,
        uint256 apyAtDeposit
    ) external returns (uint256);

    function burn(uint256 tokenId) external;
    function getPosition(uint256 tokenId) external view returns (Position memory);
    function isMatured(uint256 tokenId) external view returns (bool);
    function ownerOf(uint256 tokenId) external view returns (address);
    function exists(uint256 tokenId) external view returns (bool);
}

interface IYieldDistributor {
    struct InjectionRecord {
        uint256 timestamp;
        uint256 amount;
        bytes32 attestationHash;
        address caller;
    }

    function injectYield(uint256 amount, bytes32 attestationHash) external;
    function getInjectionHistory() external view returns (InjectionRecord[] memory);
}
