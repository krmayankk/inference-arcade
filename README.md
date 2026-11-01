# Inference Arcade

An arcade game that is also an honest picture of how GPUs serve large language models —
and that can be plugged into a real cluster so the game and the cluster move each other.

- **Play:** https://krmayankk.github.io/inference-arcade/game/ — Tokenworks (three levels + endless; press X for the metric panel)
- **Watch a bot play:** https://krmayankk.github.io/inference-arcade/game/?bot=1&lvl=2&x=1
- **Plan:** [PLAN.md](PLAN.md) — the game design, the metric → game-piece mapping, and the phases
- **The cluster it connects to:** [gpu-inference](https://github.com/krmayankk/gpu-inference)
  (vLLM serving Qwen on EKS; the L4 numbers in the game are measured there)

## What's here (Phase 1)

| Path | What |
|---|---|
| `game/` | Tokenworks: `sim.js` (the engine, pure JS, runs in node too), `main.js` (PixiJS renderer + input), `index.html` |
| `sim/arcade-bots.js` | headless bots that play every level the naive way and the intended way; a level is balanced when naive loses and intended wins |
| `sim/headless/` | bot driver + screenshot script for checking the game renders without a browser session |
| `docs/phase-1.md` | what Phase 1 built, the numbers behind it, bot results, the playtest checklist |
| `docs/phase-2.md` | Phase 2, one PR per enhancement: what each changed and what the bots say |
| `prototypes/token-kitchen.html` | the first prototype (kitchen metaphor), kept for reference; `sim/bots.js` plays it |

Run the bots: `node sim/arcade-bots.js 3`
