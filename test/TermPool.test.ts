import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  TermVault,
  TermPositionNFT,
  YieldDistributor,
  TermVaultFactory,
  MockERC20,
} from "../typechain-types";

describe("TERM Pool", function () {
  let vault: TermVault;
  let positionNFT: TermPositionNFT;
  let yieldDistributor: YieldDistributor;
  let factory: TermVaultFactory;
  let mockUSDC: MockERC20;

  let owner: any, treasury: any, user1: any, user2: any, user3: any;

  const TERM_90_DAYS = 90 * 86400;
  const TERM_180_DAYS = 180 * 86400;
  const TERM_270_DAYS = 270 * 86400;

  const APY_90D = 600; // 6% in basis points
  const APY_180D = 800; // 8% in basis points
  const APY_270D = 1000; // 10% in basis points

  beforeEach(async function () {
    [owner, treasury, user1, user2, user3] = await ethers.getSigners();

    // Deploy mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockUSDC = await MockERC20.deploy("USD Coin", "USDC", 6);
    await mockUSDC.waitForDeployment();

    // Mint tokens to users
    const mintAmount = ethers.parseUnits("100000", 6);
    await mockUSDC.mint(user1.address, mintAmount);
    await mockUSDC.mint(user2.address, mintAmount);
    await mockUSDC.mint(user3.address, mintAmount);
    await mockUSDC.mint(treasury.address, mintAmount);

    // Deploy factory
    const TermVaultFactory = await ethers.getContractFactory("TermVaultFactory");
    factory = await TermVaultFactory.deploy();
    await factory.waitForDeployment();

    // Create vault through factory
    const tx = await factory.createVault(
      await mockUSDC.getAddress(),
      [TERM_90_DAYS, TERM_180_DAYS, TERM_270_DAYS],
      [APY_90D, APY_180D, APY_270D],
      ethers.parseUnits("1000000", 6), // deposit cap
      ethers.parseUnits("100", 6), // min deposit
      owner.address
    );

    const receipt = await tx.wait();
    const event = receipt?.logs.find(
      (log: any) => log.fragment?.name === "VaultCreated"
    );

    vault = await ethers.getContractAt("TermVault", event?.args?.vault);
    positionNFT = await ethers.getContractAt("TermPositionNFT", event?.args?.positionNFT);

    // Deploy yield distributor
    const YieldDistributor = await ethers.getContractFactory("YieldDistributor");
    yieldDistributor = await YieldDistributor.deploy(
      await mockUSDC.getAddress(),
      await vault.getAddress(),
      owner.address
    );
    await yieldDistributor.waitForDeployment();

    // Authorize yield distributor
    await vault.setYieldInjector(await yieldDistributor.getAddress(), true);
    await vault.grantRole(await vault.YIELD_INJECTOR_ROLE(), treasury.address);

    // Approve tokens
    await mockUSDC.connect(user1).approve(await vault.getAddress(), mintAmount);
    await mockUSDC.connect(user2).approve(await vault.getAddress(), mintAmount);
    await mockUSDC.connect(user3).approve(await vault.getAddress(), mintAmount);
    await mockUSDC.connect(treasury).approve(await yieldDistributor.getAddress(), mintAmount);
  });

  describe("Deployment", function () {
    it("Should set correct parameters", async function () {
      expect(await vault.asset()).to.equal(await mockUSDC.getAddress());
      expect(await vault.positionNFT()).to.equal(await positionNFT.getAddress());
      expect(await vault.depositCap()).to.equal(ethers.parseUnits("1000000", 6));
      expect(await vault.minDeposit()).to.equal(ethers.parseUnits("100", 6));
    });

    it("Should have correct term configurations", async function () {
      expect(await vault.getTermCount()).to.equal(3);

      const [duration90, apy90] = await vault.getTermInfo(0);
      expect(duration90).to.equal(TERM_90_DAYS);
      expect(apy90).to.equal(APY_90D);

      const [duration180, apy180] = await vault.getTermInfo(1);
      expect(duration180).to.equal(TERM_180_DAYS);
      expect(apy180).to.equal(APY_180D);
    });

    it("Should authorize vault in NFT contract", async function () {
      expect(await positionNFT.authorizedVaults(await vault.getAddress())).to.be.true;
    });
  });

  describe("Deposits", function () {
    it("Should accept deposits with valid parameters", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);

      await expect(vault.connect(user1).deposit(depositAmount, 0, user1.address))
        .to.emit(vault, "Deposit")
        .withArgs(
          1,
          user1.address,
          depositAmount,
          TERM_90_DAYS,
          await time.latest() + TERM_90_DAYS,
          APY_90D
        );

      expect(await vault.totalPrincipal()).to.equal(depositAmount);
      expect(await positionNFT.ownerOf(1)).to.equal(user1.address);
    });

    it("Should mint position NFT with correct data", async function () {
      const depositAmount = ethers.parseUnits("5000", 6);
      await vault.connect(user1).deposit(depositAmount, 1, user1.address);

      const position = await positionNFT.getPosition(1);
      expect(position.principal).to.equal(depositAmount);
      expect(position.apyAtDeposit).to.equal(APY_180D);
      expect(position.termDuration).to.equal(TERM_180_DAYS);
      expect(position.redeemed).to.be.false;
    });

    it("Should reject deposits below minimum", async function () {
      const smallAmount = ethers.parseUnits("50", 6);
      await expect(vault.connect(user1).deposit(smallAmount, 0, user1.address))
        .to.be.revertedWithCustomError(vault, "BelowMinimumDeposit");
    });

    it("Should reject deposits above cap", async function () {
      const largeAmount = ethers.parseUnits("2000000", 6);
      await expect(vault.connect(user1).deposit(largeAmount, 0, user1.address))
        .to.be.revertedWithCustomError(vault, "DepositCapExceeded");
    });

    it("Should reject deposits with invalid term index", async function () {
      await expect(vault.connect(user1).deposit(ethers.parseUnits("1000", 6), 5, user1.address))
        .to.be.revertedWithCustomError(vault, "InvalidTermIndex");
    });

    it("Should reject zero amount deposits", async function () {
      await expect(vault.connect(user1).deposit(0, 0, user1.address))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("Should track multiple deposits", async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("1000", 6), 0, user1.address);
      await vault.connect(user2).deposit(ethers.parseUnits("2000", 6), 1, user2.address);
      await vault.connect(user3).deposit(ethers.parseUnits("3000", 6), 2, user3.address);

      expect(await vault.totalPrincipal()).to.equal(ethers.parseUnits("6000", 6));
      expect(await positionNFT.totalMinted()).to.equal(3);
    });

    it("Should allow deposit to different receiver", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);
      await vault.connect(user1).deposit(depositAmount, 0, user2.address);

      expect(await positionNFT.ownerOf(1)).to.equal(user2.address);
    });
  });

  describe("Yield Calculation", function () {
    it("Should calculate yield correctly for 90 days", async function () {
      const principal = ethers.parseUnits("10000", 6);
      const yieldAmount = await vault.calculateYield(principal, APY_90D, TERM_90_DAYS);

      // Expected: 10000 * 6% * 90 / 365 = ~147.95
      expect(yieldAmount).to.be.closeTo(ethers.parseUnits("147.95", 6), ethers.parseUnits("0.01", 6));
    });

    it("Should calculate yield correctly for 180 days", async function () {
      const principal = ethers.parseUnits("10000", 6);
      const yieldAmount = await vault.calculateYield(principal, APY_180D, TERM_180_DAYS);

      // Expected: 10000 * 8% * 180 / 365 = ~394.52
      expect(yieldAmount).to.be.closeTo(ethers.parseUnits("394.52", 6), ethers.parseUnits("0.01", 6));
    });

    it("Should return correct preview for position", async function () {
      const depositAmount = ethers.parseUnits("10000", 6);
      await vault.connect(user1).deposit(depositAmount, 0, user1.address);

      const [principal, yieldAmount, total] = await vault.previewWithdraw(1);
      expect(principal).to.equal(depositAmount);
      expect(yieldAmount).to.be.gt(0);
      expect(total).to.equal(principal + yieldAmount);
    });
  });

  describe("Withdrawals", function () {
    const depositAmount = ethers.parseUnits("5000", 6);

    beforeEach(async function () {
      await vault.connect(user1).deposit(depositAmount, 0, user1.address);
    });

    it("Should allow withdrawal after maturity", async function () {
      // Fast forward past maturity
      await time.increase(TERM_90_DAYS + 1);

      const balanceBefore = await mockUSDC.balanceOf(user1.address);

      await expect(vault.connect(user1).withdraw(1))
        .to.emit(vault, "Withdraw")
        .to.emit(vault, "YieldDistributed");

      const balanceAfter = await mockUSDC.balanceOf(user1.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should burn NFT on withdrawal", async function () {
      await time.increase(TERM_90_DAYS + 1);

      await vault.connect(user1).withdraw(1);

      await expect(positionNFT.ownerOf(1))
        .to.be.revertedWithCustomError(positionNFT, "ERC721NonexistentToken");
    });

    it("Should reject withdrawal before maturity", async function () {
      await expect(vault.connect(user1).withdraw(1))
        .to.be.revertedWithCustomError(vault, "PositionNotMatured");
    });

    it("Should reject withdrawal by non-owner", async function () {
      await time.increase(TERM_90_DAYS + 1);

      await expect(vault.connect(user2).withdraw(1))
        .to.be.revertedWithCustomError(vault, "NotPositionOwner");
    });

    it("Should reject double withdrawal", async function () {
      await time.increase(TERM_90_DAYS + 1);

      await vault.connect(user1).withdraw(1);

      await expect(vault.connect(user1).withdraw(1))
        .to.be.revertedWithCustomError(vault, "PositionDoesNotExist");
    });
  });

  describe("Yield Injection", function () {
    beforeEach(async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 0, user1.address);
      await vault.connect(user2).deposit(ethers.parseUnits("5000", 6), 0, user2.address);
    });

    it("Should allow authorized injector to inject yield", async function () {
      const yieldAmount = ethers.parseUnits("100", 6);

      await expect(vault.connect(treasury).recordYieldInjection(yieldAmount))
        .to.emit(vault, "YieldInjected")
        .withArgs(yieldAmount, yieldAmount);

      expect(await vault.totalAccruedYield()).to.equal(yieldAmount);
    });

    it("Should reject yield injection by unauthorized address", async function () {
      await expect(vault.connect(user1).recordYieldInjection(ethers.parseUnits("100", 6)))
        .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("Should reject zero yield injection", async function () {
      await expect(vault.connect(treasury).recordYieldInjection(0))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("Should track multiple yield injections", async function () {
      await vault.connect(treasury).recordYieldInjection(ethers.parseUnits("100", 6));
      await vault.connect(treasury).recordYieldInjection(ethers.parseUnits("200", 6));

      expect(await vault.totalAccruedYield()).to.equal(ethers.parseUnits("300", 6));
    });

    it("Should work with YieldDistributor", async function () {
      const yieldAmount = ethers.parseUnits("150", 6);
      const attestationHash = ethers.keccak256(ethers.toUtf8Bytes("attestation-1"));

      await expect(yieldDistributor.connect(treasury).injectYield(yieldAmount, attestationHash))
        .to.emit(yieldDistributor, "YieldInjected");

      expect(await vault.totalAccruedYield()).to.equal(yieldAmount);

      const history = await yieldDistributor.getInjectionHistory();
      expect(history.length).to.equal(1);
      expect(history[0].amount).to.equal(yieldAmount);
      expect(history[0].attestationHash).to.equal(attestationHash);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow admin to set term APY", async function () {
      await vault.connect(owner).setTermAPY(0, 700);
      const [, newAPY] = await vault.getTermInfo(0);
      expect(newAPY).to.equal(700);
    });

    it("Should allow admin to set deposit cap", async function () {
      await vault.connect(owner).setDepositCap(ethers.parseUnits("2000000", 6));
      expect(await vault.depositCap()).to.equal(ethers.parseUnits("2000000", 6));
    });

    it("Should allow admin to set min deposit", async function () {
      await vault.connect(owner).setMinDeposit(ethers.parseUnits("200", 6));
      expect(await vault.minDeposit()).to.equal(ethers.parseUnits("200", 6));
    });

    it("Should allow admin to pause and unpause", async function () {
      await vault.connect(owner).pause();
      expect(await vault.paused()).to.be.true;

      await expect(vault.connect(user1).deposit(ethers.parseUnits("1000", 6), 0, user1.address))
        .to.be.revertedWithCustomError(vault, "EnforcedPause");

      await vault.connect(owner).unpause();
      expect(await vault.paused()).to.be.false;
    });

    it("Should allow admin to manage yield injectors", async function () {
      await vault.connect(owner).setYieldInjector(user1.address, true);
      expect(await vault.hasRole(await vault.YIELD_INJECTOR_ROLE(), user1.address)).to.be.true;

      await vault.connect(owner).setYieldInjector(user1.address, false);
      expect(await vault.hasRole(await vault.YIELD_INJECTOR_ROLE(), user1.address)).to.be.false;
    });

    it("Should reject unauthorized admin actions", async function () {
      await expect(vault.connect(user1).setTermAPY(0, 700))
        .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

      await expect(vault.connect(user1).pause())
        .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });
  });

  describe("NFT Metadata", function () {
    it("Should generate token URI with position data", async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 1, user1.address);

      const tokenURI = await positionNFT.tokenURI(1);
      expect(tokenURI).to.include("data:application/json;base64");
    });

    it("Should report correct maturity status", async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 0, user1.address);

      expect(await positionNFT.isMatured(1)).to.be.false;

      await time.increase(TERM_90_DAYS + 1);

      expect(await positionNFT.isMatured(1)).to.be.true;
    });
  });

  describe("Factory", function () {
    it("Should track created vaults", async function () {
      expect(await factory.getVaultCount()).to.equal(1);

      await factory.createVault(
        await mockUSDC.getAddress(),
        [TERM_90_DAYS],
        [500],
        ethers.parseUnits("500000", 6),
        ethers.parseUnits("50", 6),
        owner.address
      );

      expect(await factory.getVaultCount()).to.equal(2);
    });

    it("Should mark vaults as valid", async function () {
      expect(await factory.isVault(await vault.getAddress())).to.be.true;
    });
  });
});
