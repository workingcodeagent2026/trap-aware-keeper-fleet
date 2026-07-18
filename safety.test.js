import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEconomics } from './safety.js';

const base = {
  gasEstimate: 100000n,
  gasPrice: 1000000n,            // 0.001 gwei
  l1FeeWei: 20000000000n,       // Base L1 data fee
  maxGasWei: 500000000n,        // 0.5 gwei ceiling
  minRewardWei: 1000000000000n, // 0.000001 ETH floor
  safetyMultiplier: 1.2,
};

test('aborts when reward below minimum', () => {
  const v = evaluateEconomics({ ...base, rewardWei: 100000000000n }); // 0.0000001 ETH
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'reward_too_low');
});

test('aborts when gas price exceeds ceiling', () => {
  const v = evaluateEconomics({ ...base, rewardWei: 1000000000000000n, gasPrice: 10n ** 18n });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'gas_price_too_high');
});

test('aborts when gas cost >= reward (unprofitable)', () => {
  const v = evaluateEconomics({ ...base, gasEstimate: 2000000n, gasPrice: 500000000n, rewardWei: 1000000000000n });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'unprofitable');
});

test('approves a clearly profitable harvest', () => {
  const v = evaluateEconomics({ ...base, rewardWei: 1000000000000000n }); // 0.001 ETH
  assert.equal(v.ok, true);
  assert.ok(v.netWei > 0n);
});

test('fails closed when the L1 fee is missing', () => {
  const { l1FeeWei, ...noL1 } = base;
  const v = evaluateEconomics({ ...noL1, rewardWei: 1000000000000000n });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'no_l1_fee');
});

test('L1 fee alone can make a harvest unprofitable', () => {
  // L2 cost = 1e12; reward clears that with buffer, but not once L1 is added.
  const rewardWei = 1300000000000n;
  const gasPrice = 10000000n;
  const withoutL1 = evaluateEconomics({ ...base, gasPrice, l1FeeWei: 0n, rewardWei });
  assert.equal(withoutL1.ok, true);
  const withL1 = evaluateEconomics({ ...base, gasPrice, l1FeeWei: 200000000000n, rewardWei });
  assert.equal(withL1.ok, false);
  assert.equal(withL1.reason, 'unprofitable');
});
