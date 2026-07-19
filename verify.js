import { ethers } from 'ethers';

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

// Sum ERC-20 `token` transfers into `recipient` across a receipt's logs.
export function sumTokenReceived(logs, token, recipient) {
  const to = ethers.zeroPadValue(recipient, 32).toLowerCase();
  let total = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() === token.toLowerCase() &&
        l.topics[0] === TRANSFER_TOPIC &&
        l.topics[2]?.toLowerCase() === to) {
      total += BigInt(l.data);
    }
  }
  return total;
}

// callReward() is only a prediction. A strategy is honest when the caller
// actually received at least minRatioMilli/1000 of what it promised.
export function isRewardHonest(actualWei, predictedWei, minRatioMilli = 500n) {
  if (predictedWei === 0n) return true;
  return actualWei * 1000n >= predictedWei * minRatioMilli;
}

// Sum every ERC-20 transfer into `recipient`, grouped by token — diagnosis
// for "paid, but not in the token we watch" (wrong-token payouts).
export function sumAllTransfersTo(logs, recipient) {
  const to = ethers.zeroPadValue(recipient, 32).toLowerCase();
  const byToken = {};
  for (const l of logs) {
    if (l.topics[0] === TRANSFER_TOPIC && l.topics[2]?.toLowerCase() === to) {
      const t = l.address.toLowerCase();
      byToken[t] = (byToken[t] ?? 0n) + BigInt(l.data);
    }
  }
  return byToken;
}

// A short payout has two innocent-until-proven explanations besides lying:
// we were front-run (the reward existed but a faster bot took it — the
// strategy's pending reward collapses to ~zero), or the strategy paid in a
// token we don't watch. Only a liar keeps promising the reward AFTER paying
// us a fraction of it.
export function classifyPayout({ actualWei, predictedWei, rewardAfterWei, otherTokensReceived, minRatioMilli = 500n }) {
  if (isRewardHonest(actualWei, predictedWei, minRatioMilli)) return 'honest';
  if (typeof rewardAfterWei === 'bigint' && rewardAfterWei * 10n < predictedWei) return 'raced';
  if (otherTokensReceived && Object.keys(otherTokensReceived).length > 0) return 'wrong_token';
  return 'liar';
}
