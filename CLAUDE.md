# Project rules for automated assistance

This is a Beefy harvest keeper that signs real transactions with a funded key.
Safety rules are ABSOLUTE and override any optimization goal.

## Files you must NEVER modify automatically
- `safety.js` — the reward-vs-gas guard and the EXECUTE gate.
- `.env`      — secrets. Never read, print, log, or commit its contents.

## Hard rules
- NEVER set or suggest running with EXECUTE=true in an automated/looped context.
- NEVER add a token approval or send ETH value in any transaction. The bot only
  ever calls harvest(); adding approve()/value breaks the honeypot-safety model.
- NEVER remove, weaken, or bypass the reward-vs-gas check or the gas-price ceiling.
- NEVER add a strategy to targets.js that is not a real, verified Beefy strategy.
- NEVER commit `.env`, private keys, or secrets.
- All `npm test` tests must pass before ANY change is proposed for merge.

## What you MAY do (proposals only, on a branch, gated by tests + my review)
- Improve logging, readability, structure, efficiency, error handling in index.js.
- Add tests. Improve the scan loop and reconnection logic.
- Propose new Beefy strategy targets ONLY as a described diff for me to review.

## Workflow
- Make changes on a new git branch, never directly on the working branch.
- Run `npm test` and report results.
- Summarize each change and STOP for human review before merging.
