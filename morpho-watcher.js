// morpho-watcher.js — read-only Morpho Blue liquidation watcher (Base).
// No key, no transactions. Measures whether the long-tail liquidation niche
// has water: positions that are (a) genuinely liquidatable, (b) priced in
// real dollars, and (c) still sitting there after the pros' reaction window.
// Junk-token positions (unpriced collateral) sit liquidatable forever and are
// ignored — liquidating them would win worthless tokens.
import 'dotenv/config';

const {
  POLL_MS = '120000',            // 2 min
  MIN_DEBT_USD = '10',           // ignore dust and unpriced junk
  MIN_BONUS_USD = '1',           // alert only when the bonus is worth claiming
  ALERT_AFTER_MS = '180000',     // 3 min unliquidated = past the pros' window
  SUMMARY_EVERY_MS = String(24 * 60 * 60 * 1000),
  CHAIN_ID = '8453',
  SCAN_ONCE = '',
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
} = process.env;

const API = 'https://blue-api.morpho.org/graphql';
const QUERY = `{
  marketPositions(first: 100, orderBy: BorrowShares, orderDirection: Desc,
    where: { chainId_in: [${Number(CHAIN_ID)}], healthFactor_lte: 1.0, borrowShares_gte: "1" }) {
    items {
      healthFactor
      user { address }
      state { borrowAssetsUsd collateralUsd }
      market { marketId lltv loanAsset { symbol } collateralAsset { symbol } }
    }
  }
}`;

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

// Morpho Blue liquidation incentive: LIF = min(1.15, 1 / (0.3 * lltv + 0.7)).
function liquidationBonusUsd(debtUsd, lltvWad) {
  const lltv = Number(lltvWad) / 1e18;
  const lif = Math.min(1.15, 1 / (0.3 * lltv + 0.7));
  return debtUsd * (lif - 1);
}

// key -> { firstSeen, alerted, debtUsd }
const tracked = new Map();
let cleared = [];   // seconds-to-clear samples since last summary
let lastSummary = Date.now();

async function poll() {
  const res = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY }),
  }).then((r) => r.json());
  const items = res?.data?.marketPositions?.items;
  if (!items) { log('warn', 'API returned no data', { errors: JSON.stringify(res?.errors ?? null).slice(0, 200) }); return; }

  const now = Date.now();
  // A real opportunity is a position that JUST crossed the line: HF slightly
  // under 1 and collateral spot value still covering the debt. Positions with
  // collateral << debt or HF near zero are depeg/bad-debt traps — the oracle
  // says the collateral is worth more than the market will pay for it, and
  // "liquidating" them means buying worthless tokens with real money.
  const eligible = items.filter((p) =>
    (p.state?.borrowAssetsUsd ?? 0) >= Number(MIN_DEBT_USD) &&
    (p.state?.collateralUsd ?? 0) >= (p.state?.borrowAssetsUsd ?? 0) &&
    p.healthFactor >= 0.7);
  const liveKeys = new Set();

  const fresh = [];
  for (const p of eligible) {
    const key = `${p.market.marketId}:${p.user.address}`;
    liveKeys.add(key);
    let t = tracked.get(key);
    if (!t) { t = { firstSeen: now, alerted: false, debtUsd: p.state.borrowAssetsUsd }; tracked.set(key, t); }
    t.debtUsd = p.state.borrowAssetsUsd;
    if (t.alerted || now - t.firstSeen < Number(ALERT_AFTER_MS)) continue;
    const bonus = liquidationBonusUsd(t.debtUsd, p.market.lltv);
    t.alerted = true; // one decision per position, alert-worthy or not
    if (bonus < Number(MIN_BONUS_USD)) continue; // marginal crumbs pros ignore — so do we
    log('info', 'liquidatable position past pro window', {
      market: `${p.market.collateralAsset?.symbol}/${p.market.loanAsset?.symbol}`,
      healthFactor: p.healthFactor, debtUsd: t.debtUsd,
      collateralUsd: p.state.collateralUsd, estBonusUsd: bonus,
      ageSec: Math.round((now - t.firstSeen) / 1000),
    });
    fresh.push({ p, bonus });
  }
  if (fresh.length > 0) {
    const lines = fresh.sort((a, b) => b.bonus - a.bonus).slice(0, 5).map(({ p, bonus }) =>
      `${p.market.collateralAsset?.symbol}/${p.market.loanAsset?.symbol} — debt $${p.state.borrowAssetsUsd.toFixed(0)}, HF ${p.healthFactor.toFixed(3)}, est. bonus $${bonus.toFixed(2)}`);
    await notify(`🎯 ${fresh.length} Morpho liquidation(s) sitting unclaimed >${Math.round(Number(ALERT_AFTER_MS) / 60000)}min on Base:\n${lines.join('\n')}`);
  }

  // Positions gone from the eligible set were liquidated (or recovered).
  for (const [key, t] of tracked) {
    if (!liveKeys.has(key)) {
      cleared.push((now - t.firstSeen) / 1000);
      tracked.delete(key);
    }
  }

  log('debug', 'poll', { eligiblePriced: eligible.length, junkIgnored: items.length - eligible.length, tracking: tracked.size });

  if (now - lastSummary >= Number(SUMMARY_EVERY_MS)) {
    const med = cleared.length
      ? cleared.sort((a, b) => a - b)[Math.floor(cleared.length / 2)] : null;
    log('info', 'daily summary', {
      clearedPositions: cleared.length,
      medianSecondsToClear: med === null ? null : Math.round(med),
      stillTracked: tracked.size,
    });
    cleared = []; lastSummary = now;
  }
}

async function main() {
  log('info', 'Morpho liquidation watcher starting', {
    chainId: Number(CHAIN_ID), pollMs: Number(POLL_MS),
    minDebtUsd: Number(MIN_DEBT_USD), alertAfterMs: Number(ALERT_AFTER_MS),
  });
  for (;;) {
    try { await poll(); }
    catch (err) { log('error', 'poll failed', { error: err.message }); }
    if (SCAN_ONCE === 'true') break;
    await sleep(Number(POLL_MS));
  }
}

main();
