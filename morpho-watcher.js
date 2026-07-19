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
      market { marketId lltv loanAsset { symbol } collateralAsset { symbol address } }
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

// A bonus is only real if the seized collateral can be SOLD. Tokenized stocks
// and illiquid long-tail tokens sit "liquidatable" forever because dumping
// them into a four-figure pool costs more in slippage than the bonus pays
// (seen with wbCOIN: $19 bonus, $1.9k total DEX liquidity). Require deep
// enough exit liquidity before calling it an opportunity.
const liquidityCache = new Map(); // token -> { usd, vol24, at }
async function exitLiquidity(tokenAddress) {
  const hit = liquidityCache.get(tokenAddress);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit;
  let entry = { usd: 0, vol24: 0, at: Date.now() };
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress}/pools`,
    ).then((r) => r.json());
    for (const p of res?.data ?? []) {
      entry.usd += Number(p.attributes?.reserve_in_usd || 0);
      entry.vol24 += Number(p.attributes?.volume_usd?.h24 || 0);
    }
  } catch { entry = { usd: -1, vol24: -1, at: Date.now() }; } // unknown — flag, don't block
  liquidityCache.set(tokenAddress, entry);
  return entry;
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
    // Exit check: selling the seized collateral must not eat the bonus.
    // Depth alone lies too — a pool with TVL but no trades (wbCOIN: $1.9k
    // depth, $1/day volume) cannot actually absorb a sale. Require both
    // depth >= 10x debt and 24h volume >= the debt itself.
    const { usd: liq, vol24 } = await exitLiquidity(p.market.collateralAsset?.address ?? '');
    if (liq >= 0 && (liq < t.debtUsd * 10 || vol24 < t.debtUsd)) {
      log('info', 'skipped: exit too illiquid or volume-less', {
        market: `${p.market.collateralAsset?.symbol}/${p.market.loanAsset?.symbol}`,
        debtUsd: t.debtUsd, estBonusUsd: bonus,
        dexLiquidityUsd: Math.round(liq), dexVol24Usd: Math.round(vol24),
      });
      continue;
    }
    log('info', 'liquidatable position past pro window', {
      market: `${p.market.collateralAsset?.symbol}/${p.market.loanAsset?.symbol}`,
      healthFactor: p.healthFactor, debtUsd: t.debtUsd,
      collateralUsd: p.state.collateralUsd, estBonusUsd: bonus,
      ageSec: Math.round((now - t.firstSeen) / 1000),
    });
    fresh.push({ p, bonus, liq });
  }
  if (fresh.length > 0) {
    const lines = fresh.sort((a, b) => b.bonus - a.bonus).slice(0, 5).map(({ p, bonus, liq }) =>
      `${p.market.collateralAsset?.symbol}/${p.market.loanAsset?.symbol} — debt $${p.state.borrowAssetsUsd.toFixed(0)}, HF ${p.healthFactor.toFixed(3)}, est. bonus $${bonus.toFixed(2)}, exit liq ${liq < 0 ? 'UNKNOWN — verify!' : '$' + Math.round(liq)}`);
    await notify(`🎯 ${fresh.length} Morpho liquidation(s) with real exit liquidity, unclaimed >${Math.round(Number(ALERT_AFTER_MS) / 60000)}min on Base:\n${lines.join('\n')}`);
  }

  // Positions gone from the eligible set were liquidated (or recovered).
  // Positions that SURVIVE a full day are the opposite signal: the entire
  // professional market has examined and refused them — a hidden defect we
  // haven't identified yet. The pros' silence is data.
  for (const [key, t] of tracked) {
    if (!liveKeys.has(key)) {
      cleared.push((now - t.firstSeen) / 1000);
      tracked.delete(key);
    } else if (!t.trapSuspect && now - t.firstSeen > 24 * 60 * 60 * 1000) {
      t.trapSuspect = true;
      log('info', 'pros silent >24h — hidden trap likely', { key, debtUsd: t.debtUsd });
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
      trapSuspects: [...tracked.values()].filter((t) => t.trapSuspect).length,
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
