import 'dotenv/config';
import { ethers } from 'ethers';
import { EXECUTE_TRANSACTIONS, evaluateEconomics } from './safety.js';
import { makeL1FeeEstimator } from './gas.js';

// Per-chain target lists: TARGETS_FILE=targets.optimism.js for a second chain.
const { TARGETS, BEEFY_STRATEGY_ABI } = await import(`./${process.env.TARGETS_FILE || 'targets.js'}`);

const {
  BASE_RPC_URL, PRIVATE_KEY,
  SCAN_INTERVAL_MS = '60000',
  MAX_GAS_GWEI = '0.5', MIN_REWARD_WEI = '0',
  GAS_SAFETY_MULTIPLIER = '1.2', LOG_LEVEL = 'info',
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  // Multi-chain: CHAIN_ID for tx serialization; L1_FEE=oracle for OP-stack
  // chains (Base, Optimism, Mode, Fraxtal). Only set L1_FEE=none on chains
  // that genuinely have no separate L1 data fee (e.g. BSC, Avalanche).
  CHAIN_ID = '8453', L1_FEE = 'oracle',
  // Skip harvests whose projected net profit is below this (wei).
  MIN_NET_PROFIT_WEI = '0',
  // Mute a strategy after N consecutive failures, for M scans.
  MUTE_AFTER_FAILURES = '3', MUTE_SCANS = '60',
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
const minNetProfitWei = BigInt(MIN_NET_PROFIT_WEI);
const safetyMultiplier = Number(GAS_SAFETY_MULTIPLIER);
const muteAfterFailures = Number(MUTE_AFTER_FAILURES);
const muteScans = Number(MUTE_SCANS);

const estimateL1Fee = L1_FEE === 'oracle' ? makeL1FeeEstimator(provider, Number(CHAIN_ID)) : null;

const strategies = TARGETS.map((t) => ({
  cfg: t,
  contract: new ethers.Contract(t.address, BEEFY_STRATEGY_ABI, wallet),
  failCount: 0,
  mutedUntil: 0,
}));

const eth = (wei) => ethers.formatEther(wei);

async function tryStrategy(s, ctx) {
  const self = wallet.address;
  try {
    // callReward() is our reward preview. If it reverts, the ABI doesn't match → skip.
    let rewardWei;
    try { rewardWei = await s.contract.callReward(); }
    catch { log('debug', 'incompatible strategy (no callReward) — skipping', { name: s.cfg.name }); return; }

    if (rewardWei === 0n) { log('debug', 'nothing to harvest', { name: s.cfg.name }); s.failCount = 0; return; }

    // estimateGas doubles as a simulation — reverts here (paused, not ready) are caught below.
    const gasEstimate = await s.contract.harvest.estimateGas(self);
    const gasPrice = ctx.feeData.maxFeePerGas ?? ctx.feeData.gasPrice;
    const gasLimit = (gasEstimate * 120n) / 100n;

    // OP-stack chains charge an L1 data fee on top of L2 gas. If the oracle
    // call fails, l1FeeWei stays undefined and evaluateEconomics fails closed.
    // On chains with no such fee (L1_FEE=none) the true extra cost is zero.
    let l1FeeWei;
    if (!estimateL1Fee) {
      l1FeeWei = 0n;
    } else {
      try {
        const txReq = await s.contract.harvest.populateTransaction(self);
        l1FeeWei = await estimateL1Fee({
          to: txReq.to, data: txReq.data,
          nonce: ctx.nonce,
          gasLimit, maxFeePerGas: gasPrice ?? 0n,
        });
      } catch (err) {
        log('warn', 'L1 fee estimate failed', { name: s.cfg.name, error: err.shortMessage ?? err.message });
      }
    }

    const verdict = evaluateEconomics({
      rewardWei, gasEstimate, gasPrice, l1FeeWei, maxGasWei: MAX_GAS_WEI, minRewardWei, safetyMultiplier,
    });
    const belowFloor = verdict.ok && verdict.netWei < minNetProfitWei;
    log('info', !verdict.ok ? `Skip: ${verdict.reason}` : belowFloor ? 'Skip: net_profit_below_floor' : 'Harvest viable', {
      name: s.cfg.name, rewardEth: eth(rewardWei),
      gasPriceGwei: ethers.formatUnits(gasPrice ?? 0n, 'gwei'),
      l1FeeEth: l1FeeWei === undefined ? null : eth(l1FeeWei),
      totalCostEth: verdict.bufferedCost === undefined ? null : eth(verdict.bufferedCost),
    });
    s.failCount = 0;
    if (!verdict.ok || belowFloor) return;

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
    s.failCount += 1;
    log('warn', 'Strategy failed', { name: s.cfg.name, error: err.shortMessage ?? err.message, failCount: s.failCount });
    if (s.failCount >= muteAfterFailures) {
      s.mutedUntil = scanCount + muteScans;
      s.failCount = 0;
      log('info', 'Strategy muted', { name: s.cfg.name, untilScan: s.mutedUntil });
    }
  }
}

let scanCount = 0;
async function scan() {
  scanCount += 1;
  // One fee/nonce snapshot per scan — the L1 fee only needs the nonce for
  // serialization size, so a slightly stale value is fine.
  let ctx;
  try {
    const [feeData, nonce] = await Promise.all([provider.getFeeData(), wallet.getNonce()]);
    ctx = { feeData, nonce };
  } catch (err) {
    log('warn', 'Scan skipped: fee/nonce fetch failed', { error: err.shortMessage ?? err.message });
    return;
  }
  // Sequential: one wallet = one nonce at a time, no collisions.
  for (const s of strategies) {
    if (s.mutedUntil > scanCount) continue;
    await tryStrategy(s, ctx);
  }
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
