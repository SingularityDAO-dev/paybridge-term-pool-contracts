# TERM Pool - Fixed-term Yield Vault

ERC-4626 compliant vault with ERC-721 position tracking for RWA-backed fixed-term yield.

## Architecture

- **TermVault**: Main ERC-4626 vault, handles deposits/withdrawals
- **TermPositionNFT**: ERC-721 representing locked positions with metadata
- **YieldDistributor**: Multisig-controlled yield injection
- **TermVaultFactory**: Deploy new vault configurations

## Quick Start

```bash
npm install
npx hardhat compile
npx hardhat test
```

## Usage

```bash
# Start local node
npx hardhat node

# Deploy to local
npm run deploy:local
```
