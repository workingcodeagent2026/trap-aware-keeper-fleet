export const EXECUTE_TRANSACTIONS = process.env.EXECUTE === 'true';

export function evaluateEconomics({
  rewardWei, gasEstimate, gasPrice, l1FeeWei,
  maxGasWei, minRewardWei, safetyMultiplier,
}) {
  if (rewardWei < minRewardWei) return { ok: false, reason: 'reward_too_low' };
  if (!gasPrice) return { ok: false, reason: 'no_gas_price' };
  if (gasPrice > maxGasWei) return { ok: false, reason: 'gas_price_too_high' };

  // Fail closed: no L1 number means we do not know the real cost.
  if (typeof l1FeeWei !== 'bigint') return { ok: false, reason: 'no_l1_fee' };

  const l2CostWei = gasEstimate * gasPrice;
  const gasCostWei = l2CostWei + l1FeeWei;
  const bufferedCost = (gasCostWei * BigInt(Math.round(safetyMultiplier * 1000))) / 1000n;

  if (bufferedCost >= rewardWei) {
    return { ok: false, reason: 'unprofitable', bufferedCost, l2CostWei, l1FeeWei };
  }
  return { ok: true, bufferedCost, l2CostWei, l1FeeWei, netWei: rewardWei - bufferedCost };
}
