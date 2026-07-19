// scanner.js — read-only opportunity detector. No key, no transactions.
// Sweeps every mapped Beefy chain, measures real callReward() against that
// chain's real gas price, and notifies when a pond actually has fish:
//   - total in-the-money harvest profit on a chain exceeds MIN_ALERT_PROFIT
//   - Beefy lists a chain we've never seen (new-chain launch window)
//   - new vaults appear mid-flight (unharvested backlog, no competition yet)
import 'dotenv/config';
import { ethers } from 'ethers';

const {
  SCAN_EVERY_MS = String(6 * 60 * 60 * 1000),   // 4x daily
  MIN_ALERT_PROFIT = '0.0002',                  // ETH-equivalent per chain
  HARVEST_GAS = '600000',
  ONLY_CHAINS = '',                             // e.g. "base,optimism" for testing
  SCAN_ONCE = '',
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
} = process.env;

const CHAINS = {
  base:     { id: '8453',  rpc: 'https://base-rpc.publicnode.com' },
  optimism: { id: '10',    rpc: 'https://optimism-rpc.publicnode.com' },
  arbitrum: { id: '42161', rpc: 'https://arbitrum-one-rpc.publicnode.com' },
  mode:     { id: '34443', rpc: 'https://mainnet.mode.network' },
  fraxtal:  { id: '252',   rpc: 'https://rpc.frax.com' },
  linea:    { id: '59144', rpc: 'https://rpc.linea.build' },
  bsc:      { id: '56',    rpc: 'https://bsc-rpc.publicnode.com' },
  avax:     { id: '43114', rpc: 'https://avalanche-c-chain-rpc.publicnode.com' },
  polygon:  { id: '137',   rpc: 'https://polygon-bor-rpc.publicnode.com' },
  sonic:    { id: '146',   rpc: 'https://rpc.soniclabs.com' },
};

const ABI = ['function callReward() view returns (uint256)'];
const harvestGas = BigInt(HARVEST_GAS);
const minAlertProfit = Number(MIN_ALERT_PROFIT);
const onlyChains = ONLY_CHAINS ? ONLY_CHAINS.split(',') : null;

// Beefy price-oracle key for each chain's wrapped native token.
const NATIVE_ORACLE = {
  base: 'WETH', optimism: 'WETH', arbitrum: 'WETH', mode: 'WETH', linea: 'WETH',
  fraxtal: 'frxETH', bsc: 'WBNB', avax: 'WAVAX', polygon: 'WMATIC', sonic: 'WS',
};

const log = (level, msg, meta = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Per-process memory: what we've already seen / already alerted on.
const seenChains = new Set();
const seenVaults = new Set();
let firstScanDone = false;

// callReward() sometimes reports units of an emissions token, not native
// (seen on CLM "cow" vaults and Ramses strategies) — the number looks huge
// and is worthless. A caller fee larger than 5% of the vault's entire TVL
// (and more than a few dollars) is physically implausible: treat as a liar.
function isPlausible(rewardWei, tvlUsd, nativeUsd) {
  if (!nativeUsd) return true; // no price data — can't judge, let it through
  const rewardUsd = Number(ethers.formatEther(rewardWei)) * nativeUsd;
  return !(rewardUsd > 5 && rewardUsd > tvlUsd * 0.05);
}

async function scanChain(chain, cfg, vaults, tvlById, nativeUsd) {
  const provider = new ethers.JsonRpcProvider(cfg.rpc, undefined, { staticNetwork: true });
  let gasPrice;
  try { gasPrice = (await provider.getFeeData()).gasPrice ?? 0n; }
  catch (err) { log('warn', 'gas price fetch failed', { chain, error: err.message }); return null; }
  const gasCostWei = harvestGas * gasPrice;

  const rows = [];
  for (let i = 0; i < vaults.length; i += 5) {
    await sleep(300);
    const batch = await Promise.all(vaults.slice(i, i + 5).map(async (v) => {
      try {
        const r = await new ethers.Contract(v.strategy, ABI, provider).callReward();
        return { id: v.id, rewardWei: r };
      } catch { return null; }
    }));
    rows.push(...batch.filter(Boolean));
  }

  // In the money = reward clears 1.5x gas (buffer for estimate error).
  const cleared = rows.filter((r) => r.rewardWei * 2n > gasCostWei * 3n);
  const suspects = cleared.filter((r) => !isPlausible(r.rewardWei, tvlById[r.id] || 0, nativeUsd));
  const inMoney = cleared
    .filter((r) => isPlausible(r.rewardWei, tvlById[r.id] || 0, nativeUsd))
    .sort((a, b) => (b.rewardWei > a.rewardWei ? 1 : -1));
  const profitWei = inMoney.reduce((s, r) => s + r.rewardWei - gasCostWei, 0n);
  return { chain, answered: rows.length, total: vaults.length, inMoney, suspects, profitWei, gasCostWei };
}

async function scanOnce() {
  const [allVaults, tvls, prices] = await Promise.all([
    fetch('https://api.beefy.finance/vaults').then((r) => r.json()),
    fetch('https://api.beefy.finance/tvl').then((r) => r.json()),
    fetch('https://api.beefy.finance/prices').then((r) => r.json()).catch(() => ({})),
  ]);
  const active = allVaults.filter((v) => v.status === 'active' && v.strategy && !v.id.includes('cow'));

  const byChain = new Map();
  for (const v of active) {
    if (!byChain.has(v.chain)) byChain.set(v.chain, []);
    byChain.get(v.chain).push(v);
  }

  // Tripwire 1: a chain that appeared after startup = launch window.
  for (const chain of byChain.keys()) {
    if (firstScanDone && !seenChains.has(chain)) {
      log('info', 'NEW CHAIN detected', { chain, vaults: byChain.get(chain).length });
      await notify(`🚨 Beefy added a NEW chain: ${chain} (${byChain.get(chain).length} vaults).\nNo keeper competition yet — deploy window open.`);
    }
    seenChains.add(chain);
  }

  // Tripwire 2: vaults that appeared after startup = unharvested backlog.
  const newVaults = [];
  for (const v of active) {
    if (firstScanDone && !seenVaults.has(v.id) && CHAINS[v.chain]) newVaults.push(v);
    seenVaults.add(v.id);
  }
  if (newVaults.length > 0 && newVaults.length <= 20) {
    log('info', 'new vaults listed', { count: newVaults.length, ids: newVaults.map((v) => v.id) });
    await notify(`🌱 ${newVaults.length} new Beefy vault(s):\n${newVaults.map((v) => `${v.chain}: ${v.id}`).join('\n')}`);
  }

  for (const [chain, cfg] of Object.entries(CHAINS)) {
    if (onlyChains && !onlyChains.includes(chain)) continue;
    const vaults = byChain.get(chain) ?? [];
    if (vaults.length === 0) continue;
    const tvlById = tvls[cfg.id] || {};
    const nativeUsd = prices[NATIVE_ORACLE[chain]];
    const res = await scanChain(chain, cfg, vaults, tvlById, nativeUsd);
    if (!res) continue;
    const profitEth = Number(ethers.formatEther(res.profitWei));
    log('info', 'chain scanned', {
      chain, vaults: res.total, answered: res.answered,
      inMoney: res.inMoney.length, suspectedUnitLiars: res.suspects.length,
      profitEth: profitEth.toFixed(6),
      gasCostEth: Number(ethers.formatEther(res.gasCostWei)).toFixed(8),
    });
    if (profitEth >= minAlertProfit) {
      const top = res.inMoney.slice(0, 5)
        .map((r) => `${Number(ethers.formatEther(r.rewardWei)).toFixed(6)} ${r.id}`).join('\n');
      await notify(`💧 Water on ${chain}: ${res.inMoney.length} harvest(s) in the money, ~${profitEth.toFixed(5)} net (native units).\nVerify a payout on-chain before scaling in.\nTop:\n${top}`);
    }
  }
  firstScanDone = true;
}

async function main() {
  log('info', 'Opportunity scanner starting', {
    chains: onlyChains ?? Object.keys(CHAINS), everyMs: Number(SCAN_EVERY_MS),
  });
  for (;;) {
    try { await scanOnce(); }
    catch (err) { log('error', 'scan failed', { error: err.message }); }
    if (SCAN_ONCE === 'true') break;
    await sleep(Number(SCAN_EVERY_MS));
  }
}

main();
