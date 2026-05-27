// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {INonfungiblePositionManager} from "../../plugins/uniswap-v3/INonfungiblePositionManager.sol";

/// @title MockNonfungiblePositionManager
/// @notice Minimal stand-in for Uniswap V3's NPM so unit tests can exercise
///         `UniswapV3Plugin` end-to-end without a fork. Not a faithful AMM —
///         it tracks per-token deposits and moves real ERC20s with the same
///         msg.sender semantics as the real NPM:
///           - mint / increaseLiquidity pull tokens from msg.sender,
///           - decreaseLiquidity credits the freed tokens as "owed",
///           - collect pushes owed tokens to `recipient`,
///           - decrease/collect/burn require msg.sender to own the position.
contract MockNonfungiblePositionManager is INonfungiblePositionManager {
    struct Pos {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        address owner;
        uint256 deposited0;
        uint256 deposited1;
        uint128 owed0;
        uint128 owed1;
    }

    uint256 public nextId;
    mapping(uint256 => Pos) internal _pos;

    function mint(
        MintParams calldata p
    )
        external
        payable
        override
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (p.amount0Desired > 0)
            IERC20(p.token0).transferFrom(msg.sender, address(this), p.amount0Desired);
        if (p.amount1Desired > 0)
            IERC20(p.token1).transferFrom(msg.sender, address(this), p.amount1Desired);

        tokenId = ++nextId;
        liquidity = uint128(p.amount0Desired + p.amount1Desired);
        _pos[tokenId] = Pos({
            token0: p.token0,
            token1: p.token1,
            fee: p.fee,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            liquidity: liquidity,
            owner: p.recipient,
            deposited0: p.amount0Desired,
            deposited1: p.amount1Desired,
            owed0: 0,
            owed1: 0
        });
        return (tokenId, liquidity, p.amount0Desired, p.amount1Desired);
    }

    function increaseLiquidity(
        IncreaseLiquidityParams calldata p
    ) external payable override returns (uint128 liquidity, uint256 amount0, uint256 amount1) {
        Pos storage pos = _pos[p.tokenId];
        require(pos.owner != address(0), "no position");
        if (p.amount0Desired > 0)
            IERC20(pos.token0).transferFrom(msg.sender, address(this), p.amount0Desired);
        if (p.amount1Desired > 0)
            IERC20(pos.token1).transferFrom(msg.sender, address(this), p.amount1Desired);
        pos.deposited0 += p.amount0Desired;
        pos.deposited1 += p.amount1Desired;
        liquidity = uint128(p.amount0Desired + p.amount1Desired);
        pos.liquidity += liquidity;
        return (liquidity, p.amount0Desired, p.amount1Desired);
    }

    function decreaseLiquidity(
        DecreaseLiquidityParams calldata p
    ) external payable override returns (uint256 amount0, uint256 amount1) {
        Pos storage pos = _pos[p.tokenId];
        require(pos.owner == msg.sender, "not authorized");
        require(p.liquidity <= pos.liquidity && pos.liquidity > 0, "bad liquidity");
        // Free underlying proportional to the liquidity removed.
        amount0 = (pos.deposited0 * p.liquidity) / pos.liquidity;
        amount1 = (pos.deposited1 * p.liquidity) / pos.liquidity;
        pos.deposited0 -= amount0;
        pos.deposited1 -= amount1;
        pos.liquidity -= p.liquidity;
        pos.owed0 += uint128(amount0);
        pos.owed1 += uint128(amount1);
        return (amount0, amount1);
    }

    function collect(
        CollectParams calldata p
    ) external payable override returns (uint256 amount0, uint256 amount1) {
        Pos storage pos = _pos[p.tokenId];
        require(pos.owner == msg.sender, "not authorized");
        amount0 = pos.owed0 < p.amount0Max ? pos.owed0 : p.amount0Max;
        amount1 = pos.owed1 < p.amount1Max ? pos.owed1 : p.amount1Max;
        pos.owed0 -= uint128(amount0);
        pos.owed1 -= uint128(amount1);
        if (amount0 > 0) IERC20(pos.token0).transfer(p.recipient, amount0);
        if (amount1 > 0) IERC20(pos.token1).transfer(p.recipient, amount1);
        return (amount0, amount1);
    }

    function burn(uint256 tokenId) external payable override {
        Pos storage pos = _pos[tokenId];
        require(pos.owner == msg.sender, "not authorized");
        require(pos.liquidity == 0 && pos.owed0 == 0 && pos.owed1 == 0, "not cleared");
        delete _pos[tokenId];
    }

    function positions(
        uint256 tokenId
    )
        external
        view
        override
        returns (
            uint96,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256,
            uint256,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Pos storage pos = _pos[tokenId];
        return (
            0,
            address(0),
            pos.token0,
            pos.token1,
            pos.fee,
            pos.tickLower,
            pos.tickUpper,
            pos.liquidity,
            0,
            0,
            pos.owed0,
            pos.owed1
        );
    }

    function ownerOf(uint256 tokenId) external view override returns (address) {
        return _pos[tokenId].owner;
    }
}
