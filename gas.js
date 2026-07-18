import { ethers } from 'ethers';

// Base predeploy — the contract Base itself uses to charge the L1 data fee.
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
const ORACLE_ABI = ['function getL1Fee(bytes) view returns (uint256)'];

// Works on any OP-stack chain (Base, Optimism, Mode, Fraxtal) — same predeploy.
export function makeL1FeeEstimator(provider, chainId = 8453) {
  const oracle = new ethers.Contract(GAS_PRICE_ORACLE, ORACLE_ABI, provider);

  // The L1 fee scales with calldata size, so the oracle needs the
  // serialized transaction — not just the gas numbers.
  return async function estimateL1Fee(req) {
    const unsigned = ethers.Transaction.from({
      type: 2,
      chainId,
      to: req.to,
      data: req.data,
      value: 0n,
      nonce: req.nonce,
      gasLimit: req.gasLimit,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas ?? req.maxFeePerGas,
    });
    return await oracle.getL1Fee(unsigned.unsignedSerialized);
  };
}
