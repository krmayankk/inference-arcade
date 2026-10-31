# Phase 1 — Arcade core (built 2026-10-31)

Play: https://krmayankk.github.io/inference-arcade/game/ · Demo mode (a bot plays): `game/?bot=1&lvl=2`

## What's in it

- **The world.** Requests arrive as capsules on the left and drift toward a red cliff over their
  patience (5–6 s). Each machine is one GPU: a weights wheel (one turn = one decode step),
  rails (batch slots), a tank (KV cache), and an output chute where tokens fly out as sparks.
- **The verb.** You pilot the dispatcher ship. Click a capsule to catch it (the ship flies there if
  it's out of reach), click a machine to fire it into a rail. Right-click or Z zaps a capsule
  (sheds it: no timeout, no coins, combo halves). Keyboard: WASD, Space, 1/2, +/−, C, P, X.
- **Levers.** Rails (`max_num_seqs`) per machine; batch lock (static vs continuous batching),
  which level 2 unlocks after 8 s or 3 bounces.
- **Feedback.** Token sparks per step, coin pops and multipliers on delivery, bounce labels
  (RAILS FULL / LOCKED / TANK FULL), explosions and screen shake on timeouts, a combo counter,
  a coach line that reacts to the state, and X-ray labels (press X) that rename every piece to
  its engineering term.
- **Levels.** 1 First shift (batching), 2 Batch lock (static → continuous), 3 Two machines
  (prefix-aware routing under a rush), plus Endless. Stars are saved in localStorage.

## What the numbers are

- L4 decode step = 34.7 ms base + 0.40 ms per running sequence (base from the gpu-inference
  Phase 1 measurement: 28.8 tok/s single stream). Prefill 5,000 tok/s (estimate for a 7B FP8
  model on an L4). KV = 210k tokens ≈ 13k blocks of 16.
- Level 3's shared prompts are 16k tokens: a cold read stalls the wheel for ~3.2 s, which is
  longer than the 2.5 s TTFT limit, so "cold = late, warm = on time" is a crisp rule. Prefix
  cache entries expire 25 s after last use.

## Bot results (`node sim/arcade-bots.js 3`)

| Level | Naive play | Intended play |
|---|---|---|
| 1 | keep 2 rails → loses (6 timeouts by ~t=40) | 8 rails → 3 stars, 100% on time |
| 2 | stay on batch lock → loses | flip to continuous at 8 s → wins (1–3 stars) |
| 3 | random / round-robin routing → ~72% on time, loses the 75% bar | colour affinity → 78–94%, wins |
| Endless | — | affinity with 12 rails survives ~3.5 min, ~170k points |

## Known rough edges

- Narrow phones: the lane is cramped; capsules can overlap. Fine for a first playtest, not final.
- Level 3's 3.2 s cold stall freezes every rail on that machine (no chunked prefill yet; that is
  level 5's lever in Phase 2).
- No sound yet (Phase 2). No auto-dispatcher yet (the `?bot=1` demo shows what it will do).
- Headless Chrome's `--screenshot` sometimes composited blank machine panels while the canvas
  itself had them (confirmed by reading the canvas back). `sim/headless/shoot.sh` therefore captures
  the canvas via `toDataURL`. Along the way the renderer gained two robustness changes worth keeping:
  all graphics stay on PixiJS's batched path (`BATCHABLE_SIZE` raised) and floating texts, bursts
  and token sparks are pooled instead of created and destroyed per event.

## Playtest checklist (the Phase 1 exit criterion)

1. Hand it to someone (ideally ~10 years old) with no explanation beyond "click a capsule, then a
   machine". Do they get a capsule into a rail within 30 s?
2. Do they figure out level 1's "add rails" on their own from the coach line?
3. After level 2, can they say in their own words why the lever helped?
4. Do they ask to play again? (This is the one that matters.)
5. Note what they tried to do that the game didn't allow. That is the next verb.
