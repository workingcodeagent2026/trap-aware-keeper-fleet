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
