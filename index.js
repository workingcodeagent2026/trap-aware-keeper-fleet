import 'dotenv/config';
import { ethers } from 'ethers';
import { EXECUTE_TRANSACTIONS, evaluateEconomics } from './safety.js';
import { makeL1FeeEstimator } from './gas.js';
import { TARGETS, BEEFY_STRATEGY_ABI } from './targets.js';

const {
  BASE_RPC_URL, PRIVATE_KEY,
  SCAN_INTERVAL_MS = '60000',
  MAX_GAS_GWEI = '0.5', MIN_REWARD_WEI = '0',
  GAS_SAFETY_MULTIPLIER = '1.2', LOG_LEVEL = 'info',
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
} = process.env;

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const activeLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;
function log(level, msg, meta = {}) {
  if (LEVELS[level] > activeLevel) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));
}

async function notify(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
  } catch (err) { log('warn', 'Telegram notify failed', { error: err.message }); }
}

function requireEnv(name, value) {
  if (!value) { log('error', `Missing required env var: ${name}`); process.exit(1); }
}
requireEnv('BASE_RPC_URL', BASE_RPC_URL);
requireEnv('PRIVATE_KEY', PRIVATE_KEY);

const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const MAX_GAS_WEI = ethers.parseUnits(MAX_GAS_GWEI, 'gwei');
const minRewardWei = BigInt(MIN_REWARD_WEI);
const safetyMultiplier = Number(GAS_SAFETY_MULTIPLIER);

const estimateL1Fee = makeL1FeeEstimator(provider);

const strategies = TARGETS.map((t) => ({
  cfg: t,
  contract: new ethers.Contract(t.address, BEEFY_STRATEGY_ABI, wallet),
}));

const eth = (wei) => ethers.formatEther(wei);

async function tryStrategy(s) {
  const self = wallet.address;
  try {
    // callReward() is our reward preview. If it reverts, the ABI doesn't match → skip.
    let rewardWei;
    try { rewardWei = await s.contract.callReward(); }
    catch { log('debug', 'incompatible strategy (no callReward) — skipping', { name: s.cfg.name }); return; }

    if (rewardWei === 0n) { log('debug', 'nothing to harvest', { name: s.cfg.name }); return; }

    // estimateGas doubles as a simulation — reverts here (paused, not ready) are caught below.
    const gasEstimate = await s.contract.harvest.estimateGas(self);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    const gasLimit = (gasEstimate * 120n) / 100n;

    // Base charges an L1 data fee on top of L2 gas. If the oracle call fails,
    // l1FeeWei stays undefined and evaluateEconomics fails closed (no_l1_fee).
    let l1FeeWei;
    try {
      const txReq = await s.contract.harvest.populateTransaction(self);
      l1FeeWei = await estimateL1Fee({
        to: txReq.to, data: txReq.data,
        nonce: await wallet.getNonce(),
        gasLimit, maxFeePerGas: gasPrice ?? 0n,
      });
    } catch (err) {
      log('warn', 'L1 fee estimate failed', { name: s.cfg.name, error: err.shortMessage ?? err.message });
    }

    const verdict = evaluateEconomics({
      rewardWei, gasEstimate, gasPrice, l1FeeWei, maxGasWei: MAX_GAS_WEI, minRewardWei, safetyMultiplier,
    });
    log('info', verdict.ok ? 'Harvest viable' : `Skip: ${verdict.reason}`, {
      name: s.cfg.name, rewardEth: eth(rewardWei),
      gasPriceGwei: ethers.formatUnits(gasPrice ?? 0n, 'gwei'),
      l1FeeEth: l1FeeWei === undefined ? null : eth(l1FeeWei),
      totalCostEth: verdict.bufferedCost === undefined ? null : eth(verdict.bufferedCost),
    });
    if (!verdict.ok) return;

    if (!EXECUTE_TRANSACTIONS) {
      await notify(`🧪 Dry-run: ${s.cfg.name} harvest reward ~${eth(rewardWei)} ETH (not sent)`);
      return;
    }
    const tx = await s.contract.harvest(self, { gasLimit, maxFeePerGas: gasPrice });
    log('info', 'Harvest sent', { name: s.cfg.name, hash: tx.hash });
    await notify(`📤 ${s.cfg.name} harvest sent\n${tx.hash}`);
    const rc = await tx.wait();
    log('info', 'Harvest confirmed', { name: s.cfg.name, hash: tx.hash, block: rc.blockNumber });
    await notify(`✅ ${s.cfg.name} harvested (block ${rc.blockNumber}) ~${eth(rewardWei)} ETH`);
  } catch (err) {
    log('warn', 'Strategy failed', { name: s.cfg.name, error: err.shortMessage ?? err.message });
  }
}

async function scan() {
  // Sequential: one wallet = one nonce at a time, no collisions.
  for (const s of strategies) await tryStrategy(s);
}

async function main() {
  const bal = await provider.getBalance(wallet.address);
  log('info', 'Starting Beefy keeper', { address: wallet.address, strategies: strategies.length, execute: EXECUTE_TRANSACTIONS });
  await notify(`🐮 Beefy keeper online\nAddress: ${wallet.address}\nGas balance: ${eth(bal)} ETH\nStrategies: ${strategies.length}\nExecute: ${EXECUTE_TRANSACTIONS}`);
  await scan();
  setInterval(scan, Number(SCAN_INTERVAL_MS));
}

process.on('unhandledRejection', (r) => log('error', 'Unhandled rejection', { reason: String(r) }));
process.on('uncaughtException', (e) => { log('error', 'Uncaught — exiting', { error: e.message }); process.exit(1); });
main().catch((e) => { log('error', 'Fatal startup', { error: e.message }); process.exit(1); });
