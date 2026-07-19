import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { sumTokenReceived, sumAllTransfersTo, isRewardHonest, classifyPayout } from './verify.js';

const WETH = '0x4200000000000000000000000000000000000006';
const ME = '0x00000000000000000000000000000000DeaDBeef';
const OTHER = '0x1111111111111111111111111111111111111111';
const TRANSFER = ethers.id('Transfer(address,address,uint256)');

const transferLog = (token, to, amountWei) => ({
  address: token,
  topics: [TRANSFER, ethers.zeroPadValue(OTHER, 32), ethers.zeroPadValue(to, 32)],
  data: ethers.toBeHex(amountWei, 32),
});

test('sums only our transfers of the right token', () => {
  const logs = [
    transferLog(WETH, ME, 100n),
    transferLog(WETH, ME, 25n),
    transferLog(WETH, OTHER, 999n),          // someone else's cut
    transferLog(OTHER, ME, 999n),            // different token
  ];
  assert.equal(sumTokenReceived(logs, WETH, ME), 125n);
});

test('returns 0n when nothing was received', () => {
  assert.equal(sumTokenReceived([], WETH, ME), 0n);
});

test('honest when payout matches prediction', () => {
  assert.equal(isRewardHonest(1000n, 1000n), true);
  assert.equal(isRewardHonest(600n, 1000n), true);   // 60% >= 50% default
});

test('dishonest when payout is a fraction of prediction', () => {
  assert.equal(isRewardHonest(1n, 1000n), false);
  assert.equal(isRewardHonest(499n, 1000n), false);  // just under 50%
});

test('zero prediction is trivially honest', () => {
  assert.equal(isRewardHonest(0n, 0n), true);
});

test('sumAllTransfersTo groups by token', () => {
  const logs = [
    transferLog(WETH, ME, 100n),
    transferLog(OTHER, ME, 7n),
    transferLog(OTHER, ME, 3n),
    transferLog(WETH, OTHER, 999n),
  ];
  assert.deepEqual(sumAllTransfersTo(logs, ME), {
    [WETH.toLowerCase()]: 100n,
    [OTHER.toLowerCase()]: 10n,
  });
});

test('full payout classifies honest', () => {
  assert.equal(classifyPayout({ actualWei: 1000n, predictedWei: 1000n }), 'honest');
});

test('short payout + collapsed pending = raced, not liar', () => {
  assert.equal(classifyPayout({
    actualWei: 1n, predictedWei: 1000n, rewardAfterWei: 0n,
  }), 'raced');
});

test('short payout + other tokens received = wrong_token', () => {
  assert.equal(classifyPayout({
    actualWei: 0n, predictedWei: 1000n, rewardAfterWei: 900n,
    otherTokensReceived: { '0xtoken': 5n },
  }), 'wrong_token');
});

test('short payout + still promising big = liar', () => {
  assert.equal(classifyPayout({
    actualWei: 1n, predictedWei: 1000n, rewardAfterWei: 900n,
    otherTokensReceived: {},
  }), 'liar');
});
