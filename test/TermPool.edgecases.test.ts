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

describe("TERM Pool - Edge Cases & Full Coverage", function () {
  let vault: TermVault;
  let positionNFT: TermPositionNFT;
  let yieldDistributor: YieldDistributor;
  let factory: TermVaultFactory;
  let mockUSDC: MockERC20;

  let owner: any, treasury: any, user1: any, user2: any, user3: any;

  const TERM_90_DAYS = 90 * 86400;
  const TERM_180_DAYS = 180 * 86400;
  const TERM_270_DAYS = 270 * 86400;

  const APY_90D = 600;
  const APY_180D = 800;
  const APY_270D = 1000;

  beforeEach(async function () {
    [owner, treasury, user1, user2, user3] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockUSDC = await MockERC20.deploy("USD Coin", "USDC", 6);
    await mockUSDC.waitForDeployment();

    const mintAmount = ethers.parseUnits("100000", 6);
    await mockUSDC.mint(user1.address, mintAmount);
    await mockUSDC.mint(user2.address, mintAmount);
    await mockUSDC.mint(user3.address, mintAmount);
    await mockUSDC.mint(treasury.address, mintAmount);

    const TermVaultFactory = await ethers.getContractFactory("TermVaultFactory");
    factory = await TermVaultFactory.deploy();
    await factory.waitForDeployment();

    const tx = await factory.createVault(
      await mockUSDC.getAddress(),
      [TERM_90_DAYS, TERM_180_DAYS, TERM_270_DAYS],
      [APY_90D, APY_180D, APY_270D],
      ethers.parseUnits("1000000", 6),
      ethers.parseUnits("100", 6),
      owner.address
    );

    const receipt = await tx.wait();
    const event = receipt?.logs.find((log: any) => log.fragment?.name === "VaultCreated");

    vault = await ethers.getContractAt("TermVault", event?.args?.vault);
    positionNFT = await ethers.getContractAt("TermPositionNFT", event?.args?.positionNFT);

    const YieldDistributor = await ethers.getContractFactory("YieldDistributor");
    yieldDistributor = await YieldDistributor.deploy(
      await mockUSDC.getAddress(),
      await vault.getAddress(),
      owner.address
    );
    await yieldDistributor.waitForDeployment();

    await vault.setYieldInjector(await yieldDistributor.getAddress(), true);
    await vault.grantRole(await vault.YIELD_INJECTOR_ROLE(), treasury.address);

    // Approve large amounts for all tests
    const largeApproval = ethers.parseUnits("10000000", 6);
    await mockUSDC.connect(user1).approve(await vault.getAddress(), largeApproval);
    await mockUSDC.connect(user2).approve(await vault.getAddress(), largeApproval);
    await mockUSDC.connect(user3).approve(await vault.getAddress(), largeApproval);
    await mockUSDC.connect(treasury).approve(await yieldDistributor.getAddress(), largeApproval);
    await mockUSDC.connect(treasury).approve(await vault.getAddress(), largeApproval);
  });

  describe("Constructor Validations", function () {
    it("Should revert with mismatched duration/APY arrays", async function () {
      const TermVault = await ethers.getContractFactory("TermVault");
      await expect(
        TermVault.deploy(
          await mockUSDC.getAddress(),
          await positionNFT.getAddress(),
          [TERM_90_DAYS, TERM_180_DAYS],
          [APY_90D],
          ethers.parseUnits("1000000", 6),
          ethers.parseUnits("100", 6),
          owner.address
        )
      ).to.be.revertedWith("Duration/APY mismatch");
    });

    it("Should revert with empty terms", async function () {
      const TermVault = await ethers.getContractFactory("TermVault");
      await expect(
        TermVault.deploy(
          await mockUSDC.getAddress(),
          await positionNFT.getAddress(),
          [],
          [],
          ethers.parseUnits("1000000", 6),
          ethers.parseUnits("100", 6),
          owner.address
        )
      ).to.be.revertedWith("No terms configured");
    });
  });

  describe("Deposit Edge Cases", function () {
    it("Should handle exact minimum deposit", async function () {
      const minDeposit = await vault.minDeposit();
      await expect(vault.connect(user1).deposit(minDeposit, 0, user1.address))
        .to.emit(vault, "Deposit");
    });

    it("Should handle deposit up to cap", async function () {
      // User1 has 100,000 USDC, deposit it all
      const user1Balance = await mockUSDC.balanceOf(user1.address);
      await expect(vault.connect(user1).deposit(user1Balance, 0, user1.address))
        .to.emit(vault, "Deposit");
      
      expect(await vault.totalPrincipal()).to.equal(user1Balance);
    });

    it("Should fail when deposit cap would be exceeded", async function () {
      // First deposit up to near cap with user2
      await vault.connect(user2).deposit(ethers.parseUnits("50000", 6), 0, user2.address);
      
      // Then user3 deposits more, exceeding cap
      await expect(vault.connect(user3).deposit(ethers.parseUnits("1000000", 6), 0, user3.address))
        .to.be.revertedWithCustomError(vault, "DepositCapExceeded");
    });

    it("Should accumulate multiple deposits correctly", async function () {
      const amount = ethers.parseUnits("1000", 6);
      
      for (let i = 0; i < 5; i++) {
        await vault.connect(user1).deposit(amount, 0, user1.address);
      }
      
      expect(await vault.totalPrincipal()).to.equal(amount * 5n);
    });

    it("Should handle deposits to all term options", async function () {
      const amount = ethers.parseUnits("1000", 6);
      
      await vault.connect(user1).deposit(amount, 0, user1.address);
      await vault.connect(user2).deposit(amount, 1, user2.address);
      await vault.connect(user3).deposit(amount, 2, user3.address);
      
      expect(await positionNFT.totalMinted()).to.equal(3);
    });
  });

  describe("View Functions", function () {
    beforeEach(async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 0, user1.address);
      await vault.connect(treasury).recordYieldInjection(ethers.parseUnits("100", 6));
    });

    it("Should return correct totalAssets", async function () {
      const totalAssets = await vault.totalAssets();
      expect(totalAssets).to.equal(ethers.parseUnits("5100", 6));
    });

    it("Should return correct availableYield", async function () {
      const availableYield = await vault.availableYield();
      expect(availableYield).to.equal(ethers.parseUnits("100", 6));
    });

    it("Should return correct totalOutstanding", async function () {
      const outstanding = await vault.totalOutstanding();
      expect(outstanding).to.equal(ethers.parseUnits("5100", 6));
    });

    it("Should return correct term count", async function () {
      expect(await vault.getTermCount()).to.equal(3);
    });

    it("Should return correct BASIS_POINTS constant", async function () {
      expect(await vault.BASIS_POINTS()).to.equal(10000);
    });

    it("Should return correct SECONDS_PER_DAY constant", async function () {
      expect(await vault.SECONDS_PER_DAY()).to.equal(86400);
    });
  });

  describe("Yield Calculation Edge Cases", function () {
    it("Should calculate yield for 1 day", async function () {
      const principal = ethers.parseUnits("10000", 6);
      const yieldAmount = await vault.calculateYield(principal, APY_90D, 86400);
      
      // 10000 * 6% * 1 / 365 = ~1.64
      expect(yieldAmount).to.be.closeTo(ethers.parseUnits("1.64", 6), ethers.parseUnits("0.01", 6));
    });

    it("Should calculate yield for 365 days", async function () {
      const principal = ethers.parseUnits("10000", 6);
      const yieldAmount = await vault.calculateYield(principal, APY_90D, 365 * 86400);
      
      // 10000 * 6% * 365 / 365 = 600
      expect(yieldAmount).to.be.closeTo(ethers.parseUnits("600", 6), ethers.parseUnits("0.01", 6));
    });

    it("Should return zero for zero principal", async function () {
      const yieldAmount = await vault.calculateYield(0, APY_90D, TERM_90_DAYS);
      expect(yieldAmount).to.equal(0);
    });

    it("Should return zero for zero APY", async function () {
      const principal = ethers.parseUnits("10000", 6);
      const yieldAmount = await vault.calculateYield(principal, 0, TERM_90_DAYS);
      expect(yieldAmount).to.equal(0);
    });

    it("Should return zero for zero duration", async function () {
      const principal = ethers.parseUnits("10000", 6);
      const yieldAmount = await vault.calculateYield(principal, APY_90D, 0);
      expect(yieldAmount).to.equal(0);
    });

    it("Should handle large principal amounts", async function () {
      const principal = ethers.parseUnits("1000000000", 6); // 1 billion
      const yieldAmount = await vault.calculateYield(principal, APY_90D, TERM_90_DAYS);
      expect(yieldAmount).to.be.gt(0);
    });
  });

  describe("Withdrawal Edge Cases", function () {
    beforeEach(async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 0, user1.address);
    });

    it("Should fail previewWithdraw for non-existent position", async function () {
      await expect(vault.previewWithdraw(999))
        .to.be.revertedWithCustomError(vault, "PositionDoesNotExist");
    });

    it("Should fail withdraw for non-existent position", async function () {
      await time.increase(TERM_90_DAYS + 1);
      await expect(vault.connect(user1).withdraw(999))
        .to.be.revertedWithCustomError(vault, "PositionDoesNotExist");
    });

    it("Should fail withdraw at exact maturity time", async function () {
      const position = await positionNFT.getPosition(1);
      await time.increaseTo(position.maturityTimestamp - 1);
      
      await expect(vault.connect(user1).withdraw(1))
        .to.be.revertedWithCustomError(vault, "PositionNotMatured");
    });

    it("Should allow withdraw exactly at maturity", async function () {
      const position = await positionNFT.getPosition(1);
      await time.increaseTo(position.maturityTimestamp);
      
      await expect(vault.connect(user1).withdraw(1))
        .to.emit(vault, "Withdraw");
    });

    it("Should update totalWithdrawn on withdrawal", async function () {
      await time.increase(TERM_90_DAYS + 1);
      
      const withdrawnBefore = await vault.totalWithdrawn();
      await vault.connect(user1).withdraw(1);
      const withdrawnAfter = await vault.totalWithdrawn();
      
      expect(withdrawnAfter).to.be.gt(withdrawnBefore);
    });
  });

  describe("Admin Role Management", function () {
    it("Should grant and revoke PARAM_SETTER_ROLE", async function () {
      await vault.grantRole(await vault.PARAM_SETTER_ROLE(), user1.address);
      expect(await vault.hasRole(await vault.PARAM_SETTER_ROLE(), user1.address)).to.be.true;
      
      await vault.revokeRole(await vault.PARAM_SETTER_ROLE(), user1.address);
      expect(await vault.hasRole(await vault.PARAM_SETTER_ROLE(), user1.address)).to.be.false;
    });

    it("Should grant and revoke PAUSER_ROLE", async function () {
      await vault.grantRole(await vault.PAUSER_ROLE(), user1.address);
      expect(await vault.hasRole(await vault.PAUSER_ROLE(), user1.address)).to.be.true;
      
      await vault.revokeRole(await vault.PAUSER_ROLE(), user1.address);
      expect(await vault.hasRole(await vault.PAUSER_ROLE(), user1.address)).to.be.false;
    });

    it("Should allow multiple addresses to have same role", async function () {
      await vault.grantRole(await vault.PAUSER_ROLE(), user1.address);
      await vault.grantRole(await vault.PAUSER_ROLE(), user2.address);
      
      expect(await vault.hasRole(await vault.PAUSER_ROLE(), user1.address)).to.be.true;
      expect(await vault.hasRole(await vault.PAUSER_ROLE(), user2.address)).to.be.true;
    });

    it("Should allow role holder to renounce role", async function () {
      await vault.grantRole(await vault.PAUSER_ROLE(), user1.address);
      await vault.connect(user1).renounceRole(await vault.PAUSER_ROLE(), user1.address);
      
      expect(await vault.hasRole(await vault.PAUSER_ROLE(), user1.address)).to.be.false;
    });
  });

  describe("NFT Edge Cases", function () {
    beforeEach(async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 0, user1.address);
    });

    it("Should return correct exists for valid token", async function () {
      expect(await positionNFT.exists(1)).to.be.true;
    });

    it("Should return correct exists for invalid token", async function () {
      expect(await positionNFT.exists(999)).to.be.false;
    });

    it("Should return correct totalMinted", async function () {
      expect(await positionNFT.totalMinted()).to.equal(1);
      
      await vault.connect(user2).deposit(ethers.parseUnits("5000", 6), 0, user2.address);
      expect(await positionNFT.totalMinted()).to.equal(2);
    });

    it("Should allow authorized vault to burn", async function () {
      await time.increase(TERM_90_DAYS + 1);
      
      const position = await positionNFT.getPosition(1);
      expect(position.redeemed).to.be.false;
      
      await vault.connect(user1).withdraw(1);
      
      const positionAfter = await positionNFT.getPosition(1);
      expect(positionAfter.redeemed).to.be.true;
    });

    it("Should fail to burn non-existent token", async function () {
      await expect(positionNFT.burn(999))
        .to.be.revertedWith("Position does not exist");
    });

    it("Should fail to getPosition for non-existent token", async function () {
      await expect(positionNFT.getPosition(999))
        .to.be.revertedWith("Position does not exist");
    });

    it("Should fail isMatured for non-existent token", async function () {
      await expect(positionNFT.isMatured(999))
        .to.be.revertedWith("Position does not exist");
    });

    it("Should support ERC721 interface", async function () {
      const ERC721InterfaceId = "0x80ac58cd";
      expect(await positionNFT.supportsInterface(ERC721InterfaceId)).to.be.true;
    });

    it("Should support ERC721Enumerable interface", async function () {
      const ERC721EnumerableInterfaceId = "0x780e9d63";
      expect(await positionNFT.supportsInterface(ERC721EnumerableInterfaceId)).to.be.true;
    });
  });

  describe("NFT Transfers", function () {
    beforeEach(async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 0, user1.address);
    });

    it("Should allow transfer of position NFT", async function () {
      await positionNFT.connect(user1).transferFrom(user1.address, user2.address, 1);
      expect(await positionNFT.ownerOf(1)).to.equal(user2.address);
    });

    it("Should allow new owner to withdraw after transfer", async function () {
      await positionNFT.connect(user1).transferFrom(user1.address, user2.address, 1);
      
      await time.increase(TERM_90_DAYS + 1);
      
      await expect(vault.connect(user2).withdraw(1))
        .to.emit(vault, "Withdraw");
    });

    it("Should prevent old owner from withdrawing after transfer", async function () {
      await positionNFT.connect(user1).transferFrom(user1.address, user2.address, 1);
      
      await time.increase(TERM_90_DAYS + 1);
      
      await expect(vault.connect(user1).withdraw(1))
        .to.be.revertedWithCustomError(vault, "NotPositionOwner");
    });

    it("Should maintain position data after transfer", async function () {
      const positionBefore = await positionNFT.getPosition(1);
      
      await positionNFT.connect(user1).transferFrom(user1.address, user2.address, 1);
      
      const positionAfter = await positionNFT.getPosition(1);
      expect(positionAfter.principal).to.equal(positionBefore.principal);
      expect(positionAfter.apyAtDeposit).to.equal(positionBefore.apyAtDeposit);
    });
  });

  describe("YieldDistributor Edge Cases", function () {
    it("Should revert constructor with zero asset address", async function () {
      const YieldDistributor = await ethers.getContractFactory("YieldDistributor");
      await expect(
        YieldDistributor.deploy(ethers.ZeroAddress, await vault.getAddress(), owner.address)
      ).to.be.revertedWithCustomError(YieldDistributor, "InvalidVault");
    });

    it("Should revert constructor with zero vault address", async function () {
      const YieldDistributor = await ethers.getContractFactory("YieldDistributor");
      await expect(
        YieldDistributor.deploy(await mockUSDC.getAddress(), ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(YieldDistributor, "InvalidVault");
    });

    it("Should emit VaultUpdated event", async function () {
      const newVault = user1.address;
      await expect(yieldDistributor.setVault(newVault))
        .to.emit(yieldDistributor, "VaultUpdated")
        .withArgs(await vault.getAddress(), newVault);
    });

    it("Should revert setVault with zero address", async function () {
      await expect(yieldDistributor.setVault(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(yieldDistributor, "InvalidVault");
    });

    it("Should revert getLatestInjection with no injections", async function () {
      await expect(yieldDistributor.getLatestInjection())
        .to.be.revertedWith("No injections");
    });

    it("Should return correct latest injection", async function () {
      const amount = ethers.parseUnits("100", 6);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      
      await yieldDistributor.connect(treasury).injectYield(amount, hash);
      
      const latest = await yieldDistributor.getLatestInjection();
      expect(latest.amount).to.equal(amount);
      expect(latest.attestationHash).to.equal(hash);
      expect(latest.caller).to.equal(treasury.address);
    });

    it("Should track multiple injections", async function () {
      for (let i = 0; i < 5; i++) {
        const amount = ethers.parseUnits((100 * (i + 1)).toString(), 6);
        const hash = ethers.keccak256(ethers.toUtf8Bytes(`test-${i}`));
        await yieldDistributor.connect(treasury).injectYield(amount, hash);
      }
      
      expect(await yieldDistributor.getInjectionCount()).to.equal(5);
      
      const history = await yieldDistributor.getInjectionHistory();
      expect(history.length).to.equal(5);
    });
  });

  describe("Factory Edge Cases", function () {
    it("Should create multiple vaults", async function () {
      await factory.createVault(
        await mockUSDC.getAddress(),
        [TERM_90_DAYS],
        [500],
        ethers.parseUnits("500000", 6),
        ethers.parseUnits("50", 6),
        owner.address
      );
      
      await factory.createVault(
        await mockUSDC.getAddress(),
        [TERM_180_DAYS],
        [700],
        ethers.parseUnits("750000", 6),
        ethers.parseUnits("75", 6),
        owner.address
      );
      
      expect(await factory.getVaultCount()).to.equal(3);
    });

    it("Should mark all created vaults as valid", async function () {
      const tx1 = await factory.createVault(
        await mockUSDC.getAddress(),
        [TERM_90_DAYS],
        [500],
        ethers.parseUnits("500000", 6),
        ethers.parseUnits("50", 6),
        owner.address
      );
      
      const receipt1 = await tx1.wait();
      const event1 = receipt1?.logs.find((log: any) => log.fragment?.name === "VaultCreated");
      
      expect(await factory.isVault(event1?.args?.vault)).to.be.true;
    });

    it("Should return all vaults", async function () {
      const allVaults = await factory.getAllVaults();
      expect(allVaults.length).to.equal(1);
    });
  });

  describe("Token URI Edge Cases", function () {
    it("Should revert tokenURI for non-existent token", async function () {
      await expect(positionNFT.tokenURI(999))
        .to.be.revertedWith("Token does not exist");
    });

    it("Should return valid JSON in tokenURI", async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 0, user1.address);
      
      const tokenURI = await positionNFT.tokenURI(1);
      expect(tokenURI).to.include("data:application/json;base64");
      
      // Decode and verify JSON structure
      const base64Data = tokenURI.split(",")[1];
      const jsonString = Buffer.from(base64Data, "base64").toString();
      const metadata = JSON.parse(jsonString);
      
      expect(metadata.name).to.include("TERM Position #1");
      expect(metadata.description).to.include("Fixed-term yield position");
      expect(metadata.attributes).to.be.an("array");
    });

    it("Should show correct status in metadata before maturity", async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 0, user1.address);
      
      const tokenURI = await positionNFT.tokenURI(1);
      const base64Data = tokenURI.split(",")[1];
      const jsonString = Buffer.from(base64Data, "base64").toString();
      const metadata = JSON.parse(jsonString);
      
      const statusAttr = metadata.attributes.find((a: any) => a.trait_type === "Status");
      expect(statusAttr.value).to.equal("Locked");
    });

    it("Should show correct status in metadata after maturity", async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 0, user1.address);
      
      await time.increase(TERM_90_DAYS + 1);
      
      const tokenURI = await positionNFT.tokenURI(1);
      const base64Data = tokenURI.split(",")[1];
      const jsonString = Buffer.from(base64Data, "base64").toString();
      const metadata = JSON.parse(jsonString);
      
      const statusAttr = metadata.attributes.find((a: any) => a.trait_type === "Status");
      expect(statusAttr.value).to.equal("Matured");
    });
  });

  describe("Comprehensive Flow Test", function () {
    it("Should handle full deposit-maturity-withdraw cycle", async function () {
      // Multiple deposits
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 6), 0, user1.address);
      await vault.connect(user2).deposit(ethers.parseUnits("20000", 6), 0, user2.address);
      
      const totalPrincipal = await vault.totalPrincipal();
      expect(totalPrincipal).to.equal(ethers.parseUnits("30000", 6));
      
      // Inject yield
      await vault.connect(treasury).recordYieldInjection(ethers.parseUnits("500", 6));
      
      // Fast forward to maturity
      await time.increase(TERM_90_DAYS + 1);
      
      // Withdrawals
      const balance1Before = await mockUSDC.balanceOf(user1.address);
      await vault.connect(user1).withdraw(1);
      const balance1After = await mockUSDC.balanceOf(user1.address);
      
      expect(balance1After).to.be.gt(balance1Before);
      
      const balance2Before = await mockUSDC.balanceOf(user2.address);
      await vault.connect(user2).withdraw(2);
      const balance2After = await mockUSDC.balanceOf(user2.address);
      
      expect(balance2After).to.be.gt(balance2Before);
      
      // Verify state
      expect(await vault.totalPrincipal()).to.equal(0);
    });

    it("Should handle concurrent positions with different terms", async function () {
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 0, user1.address); // 90d
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 1, user1.address); // 180d
      await vault.connect(user1).deposit(ethers.parseUnits("5000", 6), 2, user1.address); // 270d
      
      expect(await positionNFT.balanceOf(user1.address)).to.equal(3);
      
      // All have different maturity dates
      const pos1 = await positionNFT.getPosition(1);
      const pos2 = await positionNFT.getPosition(2);
      const pos3 = await positionNFT.getPosition(3);
      
      expect(pos2.maturityTimestamp).to.be.gt(pos1.maturityTimestamp);
      expect(pos3.maturityTimestamp).to.be.gt(pos2.maturityTimestamp);
    });
  });
});
