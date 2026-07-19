# Trap-Aware Keeper Fleet

A DeFi keeper framework for Base (and any EVM chain) built around one hard-won
principle: **every on-chain number that promises you money is lying until
verified against ground truth.**

Live on Base mainnet. One night of production operation surfaced four distinct
classes of yield traps — each is now detected automatically, and each detector
in this repo was built in direct response to losing (or nearly losing) real
money to it.

## The four traps (all encountered in production, with receipts)

| Trap | What lied | How it looked | How we catch it |
|---|---|---|---|
| **Fake rewards** | Beefy CLM ("cow") vaults' `callReward()` | Promised 0.000482 ETH, paid 0.0000001 WETH (~1000× less). 18 harvests, every one profitable on paper, every one a loss on-chain. | `verify.js` reconciles the tx receipt's actual token transfers against the prediction; strategies paying <50% of promise are blacklisted after one tx. |
| **Fake units** | Ramses (Arbitrum) strategies | `callReward()` returned "0.6 ETH" pending on an $11k-TVL vault — actually emissions-token units worth cents. | Scanner quarantines any reward implying >5% of the vault's own TVL as a unit liar. |
| **Fake solvency** | USR depeg bad debt on Morpho | Positions with $3.6M debt vs $114k collateral surfaced as "$94k liquidation bonuses." Repaying real USDC to seize depegged tokens = catastrophic loss. | Watcher requires collateral spot value ≥ debt and health factor ≥ 0.7 (a real opportunity *just* crossed 1.0, not 0.19). |
| **Fake exits** | wbCOIN (tokenized COIN stock) | Genuinely liquidatable positions with real $19 bonuses — behind a $1.9k-liquidity DEX market doing $1/day. The bonus exists; selling the collateral costs more than it pays. | Watcher checks real DEX depth (GeckoTerminal) and requires exit liquidity ≥ 10× the debt before alerting. |

The meta-lesson: anything that reaches you slowly is usually unclaimable, and
anything claimable never reaches you slowly. These tools exist to find the
narrow gap between the two — and to keep you out of everything else.

## Components

All run as hardened Docker services (`read_only`, `cap_drop: ALL`,
`no-new-privileges`, memory-capped).

### `index.js` — the harvester (the only component that spends)
Scans Beefy strategies, calls `harvest()` when — and only when — the economics
clear a layered gate:

1. **Execute gate**: transactions are off unless `EXECUTE=true` is explicitly set.
2. **Economics gate** (`safety.js`): reward must beat L2 gas + the OP-stack L1
   data fee (fetched from the GasPriceOracle predeploy, `gas.js`) with a
   safety multiplier — and fails *closed* if the L1 fee is unavailable.
3. **Gas-price ceiling**: hard cap, no exceptions.
4. **Net-profit floor**: skip crumbs even when technically profitable.
5. **Trust-but-verify** (`verify.js`): after each harvest, the receipt's actual
   wrapped-native transfers are reconciled against the prediction. Liars get
   one transaction, then a permanent blacklist.
6. **Auto-mute**: strategies that revert repeatedly get benched.

Deliberately minimal attack surface: the bot only ever calls `harvest(address)`
— no token approvals, no ETH value transfers, ever.

### `scanner.js` — cross-chain opportunity detector (read-only, no key)
Sweeps every mapped Beefy chain 4×/day, measuring *real* `callReward()` against
each chain's *live* gas price. Alerts (Telegram) only on: genuinely profitable
harvests (post unit-lie filter), a **new chain** appearing (the zero-competition
launch window — the highest-value signal in the system), or new vaults listed.

### `morpho-watcher.js` — liquidation-niche instrument (read-only, no key)
Polls Morpho Blue positions on Base, filters the three liquidation traps
(unpriced junk collateral, depeg bad debt, illiquid exits), and alerts only
when a priced, solvent, sellable opportunity survives past the professional
bots' reaction window — plus a daily time-to-clear statistic that measures
whether the niche is worth building an executor for at all.

### `discover.js` — target generation
Rebuilds per-chain strategy lists from the Beefy API, excluding known-liar
vault classes. `CHAIN=optimism OUT=targets.optimism.js node discover.js`.

## Quickstart

```sh
cp .env.optimism.example .env   # then edit: RPC url, key, chain id
npm install
npm test                        # 11 tests, all economics + verification logic
node index.js                   # dry-run by default: EXECUTE=false
# when the dry-run numbers look sane and you accept the risks:
docker compose up -d --build
```

Key env knobs (all per-chain): `MAX_GAS_GWEI`, `MIN_NET_PROFIT_WEI`,
`GAS_SAFETY_MULTIPLIER`, `REWARD_HONESTY_MILLI`, `CHAIN_ID`, `L1_FEE`
(`oracle` for OP-stack, `none` only for chains with no L1 data fee),
`TARGETS_FILE`, `MUTE_AFTER_FAILURES`, `TELEGRAM_BOT_TOKEN`/`CHAT_ID`.

## Operational safety model

This repo was developed AI-assisted under explicit standing rules (see
`CLAUDE.md`): the economics gate is a protected file no automation may touch,
execution can never be enabled by the tooling itself, secrets are never read,
and every change lands on a branch behind passing tests. The one production
incident (the cow-vault losses: −0.000255 ETH total) happened *within* those
guardrails — the gas ceiling capped the damage at about a dollar, and the fix
became the receipt-verification layer. Guardrails don't prevent lessons;
they make them affordable.

## Disclaimers

Educational infrastructure, provided as-is, no warranty. Keeper botting on
mature chains is hyper-competitive — expect the honest detectors to mostly
tell you "no opportunity," because that is the truth. Never fund the hot
wallet with more than you can lose. Not financial advice.

## License

MIT
