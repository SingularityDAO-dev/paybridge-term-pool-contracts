// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Counters} from "@openzeppelin/contracts/utils/Counters.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {ITermPositionNFT} from "./interfaces/ITermPool.sol";

contract TermPositionNFT is ERC721, ERC721Enumerable, ITermPositionNFT {
    using Counters for Counters.Counter;
    using Strings for uint256;

    Counters.Counter private _tokenIds;

    mapping(uint256 => Position) private _positions;
    mapping(address => bool) public authorizedVaults;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    event PositionCreated(
        uint256 indexed tokenId,
        address indexed owner,
        uint256 principal,
        uint256 maturityTimestamp
    );

    event PositionRedeemed(uint256 indexed tokenId);

    modifier onlyVault() {
        require(authorizedVaults[msg.sender], "Caller not authorized vault");
        _;
    }

    constructor(string memory name, string memory symbol) ERC721(name, symbol) {
        authorizedVaults[msg.sender] = true;
    }

    function authorizeVault(address vault, bool authorized) external {
        require(authorizedVaults[msg.sender], "Not authorized");
        authorizedVaults[vault] = authorized;
    }

    function mint(
        address to,
        uint256 principal,
        uint256 depositTimestamp,
        uint256 maturityTimestamp,
        uint256 termDuration,
        uint256 apyAtDeposit
    ) external onlyVault returns (uint256) {
        _tokenIds.increment();
        uint256 newTokenId = _tokenIds.current();

        _positions[newTokenId] = Position({
            principal: principal,
            depositTimestamp: depositTimestamp,
            maturityTimestamp: maturityTimestamp,
            termDuration: termDuration,
            apyAtDeposit: apyAtDeposit,
            vault: msg.sender,
            redeemed: false
        });

        _safeMint(to, newTokenId);

        emit PositionCreated(newTokenId, to, principal, maturityTimestamp);

        return newTokenId;
    }

    function burn(uint256 tokenId) external onlyVault {
        require(_positions[tokenId].vault == msg.sender, "Wrong vault");
        _positions[tokenId].redeemed = true;
        _burn(tokenId);

        emit PositionRedeemed(tokenId);
    }

    function getPosition(uint256 tokenId) external view returns (Position memory) {
        require(_exists(tokenId), "Position does not exist");
        return _positions[tokenId];
    }

    function isMatured(uint256 tokenId) external view returns (bool) {
        require(_exists(tokenId), "Position does not exist");
        return block.timestamp >= _positions[tokenId].maturityTimestamp;
    }

    function exists(uint256 tokenId) external view returns (bool) {
        return _exists(tokenId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_exists(tokenId), "Token does not exist");

        Position memory pos = _positions[tokenId];
        string memory status = block.timestamp >= pos.maturityTimestamp ? "Matured" : "Locked";
        uint256 termDays = pos.termDuration / 1 days;

        string memory json = string(abi.encodePacked(
            '{"name":"TERM Position #', tokenId.toString(), '",',
            '"description":"Fixed-term yield position in Paybridge TERM Pool",',
            '"image":"",',
            '"attributes":[',
            '{"trait_type":"Principal","display_type":"number","value":', pos.principal.toString(), '},',
            '{"trait_type":"Term Days","value":', termDays.toString(), '},',
            '{"trait_type":"APY BPS","value":', pos.apyAtDeposit.toString(), '},',
            '{"trait_type":"Maturity Date","display_type":"date","value":', pos.maturityTimestamp.toString(), '},',
            '{"trait_type":"Status","value":"', status, '"}',
            ']}'
        ));

        return string(abi.encodePacked(
            "data:application/json;base64,",
            Base64.encode(bytes(json))
        ));
    }

    function totalMinted() external view returns (uint256) {
        return _tokenIds.current();
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
