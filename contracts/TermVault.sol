// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ITermVault, ITermPositionNFT} from "./interfaces/ITermPool.sol";

contract TermVault is ITermVault, ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant PARAM_SETTER_ROLE = keccak256("PARAM_SETTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant YIELD_INJECTOR_ROLE = keccak256("YIELD_INJECTOR_ROLE");

    IERC20 public immutable _asset;

    function asset() external view returns (address) {
        return address(_asset);
    }

    ITermPositionNFT public positionNFT;

    uint256[] public termDurations;
    mapping(uint256 => uint256) public termAPYs;

    uint256 public totalPrincipal;
    uint256 public totalAccruedYield;
    uint256 public totalWithdrawn;

    uint256 public depositCap;
    uint256 public minDeposit;

    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant SECONDS_PER_DAY = 86400;

    event Deposit(
        uint256 indexed positionId,
        address indexed depositor,
        uint256 amount,
        uint256 termDuration,
        uint256 maturityDate,
        uint256 apy
    );

    event Withdraw(
        uint256 indexed positionId,
        address indexed recipient,
        uint256 principal,
        uint256 yield,
        uint256 totalPayout
    );

    event YieldInjected(uint256 amount, uint256 newTotalAccrued);
    event YieldDistributed(uint256 positionId, uint256 yieldAmount);
    event APYUpdated(uint256 indexed termIndex, uint256 oldAPY, uint256 newAPY);
    event DepositCapUpdated(uint256 oldCap, uint256 newCap);
    event MinDepositUpdated(uint256 oldMin, uint256 newMin);

    error BelowMinimumDeposit(uint256 provided, uint256 minimum);
    error DepositCapExceeded(uint256 requested, uint256 available);
    error InvalidTermIndex(uint256 provided, uint256 maxIndex);
    error PositionNotMatured(uint256 currentTime, uint256 maturityTime);
    error NotPositionOwner(address caller, address owner);
    error PositionAlreadyRedeemed(uint256 positionId);
    error PositionDoesNotExist(uint256 positionId);
    error ZeroAmount();
    error TransferFailed();

    constructor(
        address asset_,
        address positionNFT_,
        uint256[] memory termDurations_,
        uint256[] memory termAPYs_,
        uint256 depositCap_,
        uint256 minDeposit_,
        address admin
    ) {
        require(termDurations_.length == termAPYs_.length, "Duration/APY mismatch");
        require(termDurations_.length > 0, "No terms configured");

        _asset = IERC20(asset_);
        positionNFT = ITermPositionNFT(positionNFT_);
        termDurations = termDurations_;

        for (uint256 i = 0; i < termDurations_.length; i++) {
            termAPYs[i] = termAPYs_[i];
        }

        depositCap = depositCap_;
        minDeposit = minDeposit_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PARAM_SETTER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function deposit(
        uint256 amount,
        uint256 termIndex,
        address receiver
    ) external nonReentrant whenNotPaused returns (uint256 positionId) {
        if (amount == 0) revert ZeroAmount();
        if (amount < minDeposit) revert BelowMinimumDeposit(amount, minDeposit);
        if (totalPrincipal + amount > depositCap) revert DepositCapExceeded(amount, depositCap - totalPrincipal);
        if (termIndex >= termDurations.length) revert InvalidTermIndex(termIndex, termDurations.length - 1);

        uint256 maturity = block.timestamp + termDurations[termIndex];
        uint256 apy = termAPYs[termIndex];

        _asset.safeTransferFrom(msg.sender, address(this), amount);

        positionId = positionNFT.mint(
            receiver,
            amount,
            block.timestamp,
            maturity,
            termDurations[termIndex],
            apy
        );

        totalPrincipal += amount;

        emit Deposit(positionId, receiver, amount, termDurations[termIndex], maturity, apy);
    }

    function withdraw(uint256 positionId) external nonReentrant returns (uint256 payout) {
        if (!positionNFT.exists(positionId)) revert PositionDoesNotExist(positionId);
        if (positionNFT.ownerOf(positionId) != msg.sender) revert NotPositionOwner(msg.sender, positionNFT.ownerOf(positionId));

        ITermPositionNFT.Position memory pos = positionNFT.getPosition(positionId);

        if (block.timestamp < pos.maturityTimestamp) {
            revert PositionNotMatured(block.timestamp, pos.maturityTimestamp);
        }
        if (pos.redeemed) revert PositionAlreadyRedeemed(positionId);

        uint256 yieldAmount = calculateYield(pos.principal, pos.apyAtDeposit, pos.termDuration);
        payout = pos.principal + yieldAmount;

        positionNFT.burn(positionId);

        totalPrincipal -= pos.principal;
        unchecked {
            totalAccruedYield -= yieldAmount > totalAccruedYield ? totalAccruedYield : yieldAmount;
        }
        totalWithdrawn += payout;

        _asset.safeTransfer(msg.sender, payout);

        emit Withdraw(positionId, msg.sender, pos.principal, yieldAmount, payout);
        emit YieldDistributed(positionId, yieldAmount);
    }

    function calculateYield(
        uint256 principal,
        uint256 apyBps,
        uint256 termSeconds
    ) public pure returns (uint256) {
        uint256 termDays = termSeconds / SECONDS_PER_DAY;
        return (principal * apyBps * termDays) / (BASIS_POINTS * 365);
    }

    function previewWithdraw(uint256 positionId) external view returns (uint256 principal, uint256 yieldAmount, uint256 total) {
        if (!positionNFT.exists(positionId)) revert PositionDoesNotExist(positionId);

        ITermPositionNFT.Position memory pos = positionNFT.getPosition(positionId);
        principal = pos.principal;
        yieldAmount = calculateYield(pos.principal, pos.apyAtDeposit, pos.termDuration);
        total = principal + yieldAmount;
    }

    function recordYieldInjection(uint256 amount) external onlyRole(YIELD_INJECTOR_ROLE) {
        if (amount == 0) revert ZeroAmount();

        _asset.safeTransferFrom(msg.sender, address(this), amount);
        totalAccruedYield += amount;

        emit YieldInjected(amount, totalAccruedYield);
    }

    function setYieldInjector(address injector, bool authorized) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (authorized) {
            _grantRole(YIELD_INJECTOR_ROLE, injector);
        } else {
            _revokeRole(YIELD_INJECTOR_ROLE, injector);
        }
    }

    function setTermAPY(uint256 termIndex, uint256 newAPY) external onlyRole(PARAM_SETTER_ROLE) {
        if (termIndex >= termDurations.length) revert InvalidTermIndex(termIndex, termDurations.length - 1);

        uint256 oldAPY = termAPYs[termIndex];
        termAPYs[termIndex] = newAPY;

        emit APYUpdated(termIndex, oldAPY, newAPY);
    }

    function setDepositCap(uint256 newCap) external onlyRole(PARAM_SETTER_ROLE) {
        uint256 oldCap = depositCap;
        depositCap = newCap;

        emit DepositCapUpdated(oldCap, newCap);
    }

    function setMinDeposit(uint256 newMin) external onlyRole(PARAM_SETTER_ROLE) {
        uint256 oldMin = minDeposit;
        minDeposit = newMin;

        emit MinDepositUpdated(oldMin, newMin);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function getTermCount() external view returns (uint256) {
        return termDurations.length;
    }

    function getTermInfo(uint256 termIndex) external view returns (uint256 duration, uint256 apy) {
        if (termIndex >= termDurations.length) revert InvalidTermIndex(termIndex, termDurations.length - 1);
        return (termDurations[termIndex], termAPYs[termIndex]);
    }

    function totalAssets() external view returns (uint256) {
        return _asset.balanceOf(address(this));
    }

    function availableYield() external view returns (uint256) {
        return totalAccruedYield;
    }

    function totalOutstanding() external view returns (uint256) {
        return totalPrincipal + totalAccruedYield;
    }
}
