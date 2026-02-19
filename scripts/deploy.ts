import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying TERM Pool contracts with account:", deployer.address);

  // Deploy mock USDC for testing
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  console.log("MockUSDC deployed to:", await usdc.getAddress());

  // Deploy factory
  const TermVaultFactory = await ethers.getContractFactory("TermVaultFactory");
  const factory = await TermVaultFactory.deploy();
  await factory.waitForDeployment();
  console.log("TermVaultFactory deployed to:", await factory.getAddress());

  // Create vault through factory
  const TERM_90_DAYS = 90 * 86400;
  const TERM_180_DAYS = 180 * 86400;
  const TERM_270_DAYS = 270 * 86400;

  const APY_90D = 600;
  const APY_180D = 800;
  const APY_270D = 1000;

  const tx = await factory.createVault(
    await usdc.getAddress(),
    [TERM_90_DAYS, TERM_180_DAYS, TERM_270_DAYS],
    [APY_90D, APY_180D, APY_270D],
    ethers.parseUnits("1000000", 6),
    ethers.parseUnits("100", 6),
    deployer.address
  );

  const receipt = await tx.wait();
  const event = receipt?.logs.find(
    (log: any) => log.fragment?.name === "VaultCreated"
  );

  const vaultAddress = event?.args?.vault;
  const positionNFTAddress = event?.args?.positionNFT;

  console.log("TermVault deployed to:", vaultAddress);
  console.log("TermPositionNFT deployed to:", positionNFTAddress);

  // Deploy YieldDistributor
  const YieldDistributor = await ethers.getContractFactory("YieldDistributor");
  const yieldDistributor = await YieldDistributor.deploy(
    await usdc.getAddress(),
    vaultAddress,
    deployer.address
  );
  await yieldDistributor.waitForDeployment();
  console.log("YieldDistributor deployed to:", await yieldDistributor.getAddress());

  // Setup permissions
  const vault = await ethers.getContractAt("TermVault", vaultAddress);
  await vault.setYieldInjector(await yieldDistributor.getAddress(), true);
  console.log("YieldDistributor authorized as yield injector");

  // Save deployment info
  const deploymentInfo = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      mockUSDC: await usdc.getAddress(),
      factory: await factory.getAddress(),
      vault: vaultAddress,
      positionNFT: positionNFTAddress,
      yieldDistributor: await yieldDistributor.getAddress(),
    },
    terms: {
      durations: [TERM_90_DAYS, TERM_180_DAYS, TERM_270_DAYS],
      apys: [APY_90D, APY_180D, APY_270D],
    },
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir);
  }

  const filename = `deployment-${deploymentInfo.network}-${Date.now()}.json`;
  fs.writeFileSync(
    path.join(deploymentsDir, filename),
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log("\nDeployment info saved to:", filename);
  console.log("\nNext steps:");
  console.log("1. Mint USDC to test accounts: npx hardhat run scripts/mint.ts --network localhost");
  console.log("2. Deposit to vault via frontend or scripts");
  console.log("3. Inject yield via YieldDistributor");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
