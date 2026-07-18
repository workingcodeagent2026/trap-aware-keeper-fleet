# Scale-out checklist

Ranked by safety and effort. Each step is independent — do 1 first, it's free.

## 1. Triple Base coverage (no new wallet, ~5 min)

There are ~165 active Base vaults in the $100–$100k TVL band; the bot targets 50.

```sh
git merge feat/multichain-scale     # review the diff first
LIMIT=165 node discover.js          # rewrites targets.js — skim it before deploying
git add targets.js && git commit -m "Expand Base targets to 165"
docker compose up -d --build
```

## 2. Add Optimism (~15 min + small gas float)

~60 candidate vaults, gas ~6x cheaper than Base, same OP-stack safety model.

1. Create a fresh wallet; fund it with ~0.002 ETH on Optimism only.
2. `cp .env.optimism.example .env.optimism` and fill in RPC + key.
   Leave `EXECUTE=false` for the first run.
3. `CHAIN=optimism OUT=targets.optimism.js node discover.js` — skim the output.
4. Uncomment the `bot-optimism` service in docker-compose.yml.
5. `docker compose up -d --build`, watch `docker logs -f beefy-harvester-bot-optimism-1`
   for a few scans (expect `Skip:`/`Dry-run` lines with sane numbers).
6. Set `EXECUTE=true` in .env.optimism and `docker compose up -d` again.

## 3. Later: Arbitrum

35 candidate vaults. Needs L1_FEE=none plus verification that estimateGas on
Arbitrum folds the L1 data component into the gas units (it does by design,
but confirm with a dry run before enabling execution). Not worth it until
Base + Optimism are earning smoothly.

## Tuning knobs (all per-chain, in each .env)

- `MIN_NET_PROFIT_WEI` — e.g. 20000000000000 (0.00002 ETH) to skip crumbs.
- `LIMIT` / `MIN_TVL` / `MAX_TVL` on discover.js — widen the fishing net.
- `MUTE_AFTER_FAILURES` / `MUTE_SCANS` — how fast dead targets get benched.
