# Inference Arcade

An arcade game that is also an honest picture of how GPUs serve large language models —
and that can be plugged into a real cluster so the game and the cluster move each other.

- **Play:** https://krmayankk.github.io/inference-arcade/ (landing page; the game lands in Phase 1)
- **Plan:** [PLAN.md](PLAN.md) — the game design, the metric → game-piece mapping, and the phases
- **The cluster it connects to:** [gpu-inference](https://github.com/krmayankk/gpu-inference)
  (vLLM serving Qwen on EKS; the L4 numbers in the game are measured there)

## What's here now (Phase 0)

| Path | What |
|---|---|
| `prototypes/token-kitchen.html` | the first playable prototype; its simulation engine is carried into the game |
| `sim/bots.js` | headless bots that play every level of a prototype/game and report win/lose, used to balance levels |

Run the bots: `node sim/bots.js prototypes/token-kitchen.html`
