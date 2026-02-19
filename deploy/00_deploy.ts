import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  // Deploy mock USDC
  await deploy("MockERC20", {
    from: deployer,
    args: ["USD Coin", "USDC", 6],
    log: true,
  });

  // Deploy factory
  await deploy("TermVaultFactory", {
    from: deployer,
    log: true,
  });

  console.log("TERM Pool deployment complete!");
};

export default func;
func.tags = ["TermPool"];
