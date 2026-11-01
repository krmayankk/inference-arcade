# Inference Arcade — Plan

A fun arcade game that is also an honest picture of LLM inference, and that can be plugged
into a real GPU cluster ([krmayankk/gpu-inference](https://github.com/krmayankk/gpu-inference))
so the game and the cluster move each other.

Working title for the game: **Tokenworks**. The repo is the umbrella (`inference-arcade`) so
the game can change shape without changing the public URL.

## Goals, in priority order

1. **Fun first.** A 10-year-old should want to play it again. If a mechanic is true but boring,
   it loses. Reflexes, pressure, combos, bosses.
2. **Honest.** Every moving thing on screen is a real part of serving an LLM, with real
   proportions: a decode step costs the same whether 1 or 40 sequences ride it, KV memory
   caps concurrency, cold starts are slow, big prompts stall the batch.
3. **Connected.** The same screen can be driven by (a) a simulator, (b) a recorded run, or
   (c) the live EKS cluster. Concrete metrics map to concrete game pieces, and changes on
   either side show up on the other.
4. **Interview-grade.** Each level is a talking point; Live mode is its proof on hardware.

## Principles

- **One state schema.** The renderer never knows whether it is fed by the sim, a replay file,
  or the bridge. That is what makes the cluster link real instead of a bolt-on.
- **Bots gate balance.** Every level ships with a headless bot that loses the naive way and
  wins the intended way (`sim/bots.js`). No tuning by feel alone.
- **Cluster time is money.** ~$1/h per L4, ~$80 of credits. Live sessions are planned,
  short, and torn down (`make down` + `make verify` in gpu-inference).
- **Previews before commits**; no AI attribution trailers (repo convention).
- **The cluster connection is the last phase**, built on a bridge that is read-only first.

---

## The game: Tokenworks

### The world

A stylised **token factory**. No restaurant metaphor: the machine itself is the picture.

```
ingress ─▶ queue  ●●●●●          ┌──────── MACHINE = one GPU ─────────┐
                                 │   ◯  WEIGHTS WHEEL                 │
 capsule ══ribbon══▶ READER ───▶ │      one turn = one decode step    │ ──▶ ✦✦✦ tokens fly out
  (prompt = ribbon length)       │   RAILS  ●●●●●○○○   batch slots    │      → coins / score
                                 │   KV TANK ▓▓▓▓▓░░░  paged bricks   │
                                 └────────────────────────────────────┘
```

| Piece | What it is | Why it is drawn that way |
|---|---|---|
| **Capsule** | one request = one sequence (vLLM: one entry in `num_requests_running` once seated); colour = prompt family (shared prefix), ribbon = prompt length, ring = patience (client timeout) | the player must *see* length and family to route well |
| **Queue** | waiting requests; rings tick down; expired capsules explode | queueing = the first SLO to break |
| **Reader** | prefill; pulls the ribbon through before the first token; long ribbons stall the wheel | prefill is compute-bound and blocks decode steps |
| **Weights wheel** | one turn = one decode step; turn time ≈ 35 ms on an L4 regardless of load | decode is memory-bound: all 8 GB of weights stream once per step |
| **Rails** | batch slots (`max_num_seqs`); every occupied rail gets one token per turn; each occupied rail adds a thin sliver to the turn | batching is nearly free until the slivers add up (TPOT) |
| **KV tank** | paged bricks (16 tokens each) that grow as sequences lengthen; full tank pops the newest sequence back to the queue | KV cache caps concurrency; preemption is visible |
| **Gold bricks** | shared prefix blocks; fade and vanish when the tank is squeezed (LRU eviction, not a timer) | prefix caching saves both prefill and memory; eviction is why routing must stay sticky |
| **Draft wheel** | small fast wheel stamping ghost tokens that the big wheel verifies (solid or shatter) | speculative decoding |
| **Crane** | lowers a new machine; its wheel fills with weights | cold start (image pull + weight load) |
| **Sparks / short-out** | a machine fails and ejects its capsules | node/pod failure, requests re-queued |
| **Heat glow** | machine colour shifts with temperature/power | DCGM temp/power |

Two vocabularies, one world: a label toggle (X) switches plain words ↔ engineering terms
(`rails` ↔ `max_num_seqs`, `tank` ↔ `KV cache`). No second metaphor.

### The verbs (what makes it a game)

The player runs the **dispatcher cannon** on the cliff at the end of the request lane (mouse /
touch to aim, W/S to slide along the cliff, Space to shoot). *Revised after the first playtest:
catch-then-click was confusing; aim-and-shoot is the verb.*

- **Aim & shoot.** The most urgent capsule loads itself; point at a rail (a track on a machine)
  and shoot. Click another capsule in the lane to load it instead. Aim matters: same colour into
  the same machine → gold bricks and a fast read; a long ribbon into a nearly full tank → bounce;
  a full or locked track bounces the shot. This *is* the scheduler/router, played by hand.
  With a fleet, the cannon slides along the cliff to reach machines: navigation is the act of
  finding an empty GPU for a new sequence.
- **Catch.** Preempted or ejected requests fly back out of a machine; click one in flight to
  re-route it (recompute preemption, requeue on pod failure).
- **Zap.** A laser with three honest uses: cancel an expired capsule to free the queue
  (request cancellation), chop a giant ribbon into chunks so it can be read between turns
  (chunked prefill), and restart a shorted machine (pod restart).
- **Levers** (on-screen, also hotkeys): batch cap per machine, FP8 KV, prefix cache,
  speculative decoding, open/close machine. Early levels lock most of them.
- **Automation you earn.** Later levels let you *buy* an auto-dispatcher (the real router)
  and an autoscaler. Your job moves up a level: fleet shape, rush prep, routing rules
  (draw lines from ingress colours to machines), fires. The career path of an inference
  engineer, as progression.

### Pressure, bosses, score

- **Rushes** (announced 15 s ahead), **giant prompts** (a boss ribbon you must chop),
  **thundering herd** (a burst of identical prompts: route them together or drown),
  **the fire** (a machine shorts out mid-rush).
- **Score** = goodput (tokens delivered within SLO) and **coins** (revenue − rent).
  Combo multiplier for consecutive in-SLO deliveries; screen shake and loss on explosions.
- **Stars** per level; **endless mode** with a high-score table (localStorage).

### Levels (teaching order)

| # | Level | You learn by doing | Real concept |
|---|---|---|---|
| 1 | First shift ✓ | shoot capsules onto rails; more rails barely slow the wheel | batching; decode is memory-bound |
| 2 | Batch lock ✓ | tracks stay locked until the whole batch finishes; flip the lever | static vs continuous batching |
| 3 | Two machines ✓ | route by colour under a rush; cold reads stall the wheel | prefix-aware routing, prefill cost |
| 4 | Tank pressure | long ribbons fill the tank; a full tank pops a request off its track; catch it | KV cache paging, preemption (recompute) |
| 5 | Cold bricks | gold bricks fade under pressure; sticky routing keeps them warm | LRU prefix-cache eviction |
| 6 | Conversations | delivered capsules come back longer, same colour; chains build combos | multi-turn chat, prefix reuse over time |
| 7 | The giant | a boss ribbon stalls every track until you chop it | chunked prefill |
| 8 | Fleet | 3–4 machines; the cannon slides the cliff; buy a machine, wait for it to boot, pay rent | scale-out, cold start (image pull + weight load), $/GPU-hour |
| 9 | Spot pull | a machine goes dark with a countdown and ejects everything; a rollout restarts one at a time | spot interruption, pod failure, rolling restart |
| 10 | The apprentice (stretch) | a scout wheel stamps 2–3 tokens per turn when accepted | speculative decoding |
| ∞ | Endless | traffic climbs; goodput and the bill both count; buy the autoscaler | autoscaling against an SLO and a budget |

Left out on purpose: switching models mid-game (real, but it would change every number at once;
a rollout is kept only as the restart event in level 9).

---

## The state schema (the contract)

Sim, replay and bridge all emit this; the renderer only reads it. Fields marked ★ are the
concrete metric mappings (see the next table).

```jsonc
{
  "t": 123.4,                      // seconds since session start
  "source": "sim | replay | live",
  "load": { "rps": 3.2, "mix": { "short": 0.7, "shared": 0.2, "giant": 0.1 } },
  "replicas": [{
    "id": "l4-0", "gpu": "L4",
    "phase": "booting | ready | failed | terminating", "boot_pct": 0.4,   // ★ pod phase/readiness
    "max_num_seqs": 48,                                                   // ★ engine arg
    "running": 12, "waiting": 3, "waiting_capacity": 1,                   // ★ vllm:num_requests_*
    "kv_used_pct": 0.63, "kv_blocks_total": 13125,                        // ★ vllm:kv_cache_usage_perc, cache_config_info
    "step_ms": 41.0,                                                      // ★ inter-token latency p50 (window)
    "ttft_p95_ms": 900, "queue_p95_ms": 300, "prefill_p95_ms": 220,       // ★ vllm:*_seconds histograms
    "gen_tok_s": 290, "prompt_tok_s": 1800,                               // ★ rate(generation_tokens_total), rate(prompt_tokens_total)
    "prefix_hit_rate": 0.55,                                              // ★ prefix_cache_hits_total / queries_total
    "preemptions": 2,                                                     // ★ increase(num_preemptions_total)
    "gpu_util_pct": 98, "gpu_temp_c": 71, "gpu_power_w": 68, "fb_used_mib": 21000, // ★ DCGM
    "usd_per_h": 0.98
  }],
  "requests": [{ "id": "r1", "phase": "queued | prefill | decode | done | timeout",
                 "replica": "l4-0", "prompt_tokens": 420, "gen_tokens": 57,
                 "t0": 120.1, "t_first": 121.0 }],                        // sim + the player's own live streams
  "events": [{ "t": 118, "kind": "rush | giant | fire | scale | knob", "detail": "…" }]
}
```

Rates: sim at 20 Hz, replay at the recording rate, bridge at 1–2 Hz (it scrapes
`/metrics` directly, not via Prometheus's 15 s interval). The renderer interpolates.

### Metric → game piece (the concrete mapping)

| Game piece | Live source (exact) | Replay source |
|---|---|---|
| occupied rails | `vllm:num_requests_running` | `vllm_running` |
| queue length; "tank full" badge | `vllm:num_requests_waiting`, `…_by_reason{reason="capacity"}` | `vllm_waiting` |
| rail count | pod args `--max-num-seqs` | recorded |
| tank fill / tank size | `vllm:kv_cache_usage_perc`; `vllm:cache_config_info{num_gpu_blocks}` | `vllm_kv_cache_pct` |
| wheel turn time | `vllm:inter_token_latency_seconds` p50 (1-min window) + the player's own stream timing | histogram or derived |
| capsule patience ring | `vllm:time_to_first_token_seconds` p95, `vllm:request_queue_time_seconds` | derived |
| reader stall | `vllm:request_prefill_time_seconds`, `rate(vllm:prompt_tokens_total)` | `vllm_prompt_tok_per_s` |
| tokens flying out | `rate(vllm:generation_tokens_total)` | `vllm_gen_tok_per_s` |
| gold bricks | `vllm:prefix_cache_hits_total / vllm:prefix_cache_queries_total`, `vllm:prompt_tokens_cached_total` | n/a (0) |
| pop (preemption) | `increase(vllm:num_preemptions_total)` | n/a |
| heat glow, sparks | `DCGM_FI_DEV_GPU_TEMP`, `DCGM_FI_DEV_POWER_USAGE`, `DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_FB_USED`, tensor-active | `gpu_temp_c`, `gpu_power_w`, `gpu_util_pct`, `gpu_mem_used_mib`, `gpu_tensor_active` |
| crane / boot bar | Pod phase + readiness (Kubernetes API) | events |
| short-out | pod restart / node NotReady | events |
| rent, cost per 1M tokens | instance price table × ready replicas ÷ `gen_tok_s` | same |

### Cross-over effects (what "one affects the other" means, concretely)

| # | Change | Where | What you see in the game | Phase |
|---|---|---|---|---|
| 1 | turn up the load dial | game | real queue grows, wheel drags, rings expire, KV climbs | 4 |
| 2 | `kubectl scale` / replica change | EKS | a crane lowers a machine; its boot bar is the real pod becoming Ready | 4 |
| 3 | restart with `--max-num-seqs 8` or `--kv-cache-dtype fp8` | EKS | rails vanish / tank doubles within one tick | 4 |
| 4 | "open a machine" | game | a real scale-up, guarded by budget and TTL | 5 |

---

## Phases

Each phase ends with something playable or watchable, bot-tested where it is sim-driven,
and a short demo note in `docs/`. Session estimates are working sessions, not dates.

### Phase 0 — Bootstrap (this commit)

- Repo `inference-arcade`, public, GitHub Pages from `main`.
- This plan; `prototypes/token-kitchen.html` (the engine we carry forward, calibrated to the
  L4 numbers measured in gpu-inference Phase 1: 28.8 tok/s → 34.7 ms base step);
  `sim/bots.js` (headless level bots).
- **Done when:** repo is public, Pages serves `index.html` (a landing page linking the
  prototype until the game lands).

### Phase 1 — Arcade core: the fun test (2–3 sessions)

**Status (2026-10-31): built, awaiting the playtest.** See `docs/phase-1.md`. Levels 1–3 + endless, bots pass; level order differs from the table above (the two-machine routing level is level 3 because it is the fun test for the verb; the "sweet spot" level moves to Phase 2).

Build the smallest version that answers "is catch-and-fire fun?"

- `game/` with the renderer on **PixiJS** (WebGL, thousands of token particles, from cdnjs),
  the sim engine lifted from the prototype, and the state schema above.
- The dispatcher ship, catch & fire, zap (cancel only), capsules with colour/ribbon/ring.
- One machine, then two (level 8's routing mechanic is the fun test for the verb).
- Levels 1–3, combos, explosions, screen shake, a 60-second endless mode.
- Keyboard, mouse, touch. Phone-width layout.
- **Done when:** (a) bots pass levels 1–3; (b) a kid playtest: they ask to play again and can
  say what the wheel does; (c) we can describe the core verb in one sentence. If (b) fails,
  we change the verb, not the world.

### Phase 2 — Full arcade, one PR per enhancement

Phase 1 merged 2026-10-31 (PR #1). From here every enhancement is its own PR, bot-gated (the naive
bot loses, the intended bot wins) and screenshot-checked, in this order:

| PR | Enhancement | Honesty rule it enforces |
|---|---|---|
| A | **Honest pieces.** Capsule = request = one sequence, said on screen. X-ray becomes a live mapping panel: every piece shows its vLLM/DCGM metric name and current value. Prefix cache expiry becomes LRU eviction under tank pressure. Every number carries a measured/estimated badge. A rent meter ($/GPU-hour, the L4 price) and coins − rent in the score. | a senior inference engineer can read the X-ray panel and find nothing fake |
| B | **Levels 4–5.** Tank pressure (preemption pops a request off its track; catch it in flight) and Cold bricks (LRU eviction). | preemption and eviction behave as vLLM's block manager does |
| C | **Level 6 Conversations.** Delivered requests return as longer same-colour prompts; chains and combos. | multi-turn is where prefix caching pays |
| D | **Level 7 The giant.** Chunked prefill as a lever (and zap-to-chop for the boss ribbon). | decode keeps stepping while prefill is chunked |
| E | **Levels 8–9 Fleet and Spot pull.** 3–4 machines, cannon slides along the cliff, buy a machine (boot time, rent), machine dies with a warning and ejects its requests, rolling restart. | boot = image pull + weight load; spot gives a two-minute warning |
| F | **Endless with the bill.** Autoscaler to buy, goodput and $ both count; sound (off by default); phone layout. | cost per 1M tokens is computed from the same numbers the cluster reports |
| G | **Level 10 (stretch).** Speculative decoding. | acceptance rate drives the burst size |

- **Done when:** every level's bot loses the naive way and wins the intended way; a
  10-minute full playthrough recording exists in `docs/`.

### Phase 3 — Replay mode (1 session, no cluster cost)

- `replays/` format = the state schema sampled over time.
- Converter from gpu-inference run evidence (`docs/runs/<run>/evidence/prometheus-session.json`,
  `vllm-metrics.txt`) → `replays/2026-09-26-l4x4.json`.
- "Watch a real run" on the public page: the factory animates the recorded run; a timeline
  scrubber; the player can still fire capsules into the sim *on top* of the replay to see
  predicted vs recorded (digital-twin overlay: TPOT and queue depth).
- **Done when:** the l4x4 run plays back on Pages and the overlay chart renders.

### Phase 4 — Bridge + Live mode, read-only (2 sessions, ~2 h cluster time)

The bridge runs **on the laptop** against port-forwards (no in-cluster changes yet), which
matches gpu-inference's seam design and keeps the blast radius zero.

- `bridge/` (Python/FastAPI): scrapes `svc/inference:8000/metrics` at 1–2 Hz, reads pod
  phases via kubeconfig, optionally queries Prometheus for DCGM; emits the state schema over
  WebSocket; proxies streaming chat completions (so the player's fired capsules are real
  requests and the tokens on screen are the real SSE tokens); a load generator
  (`POST /load {rps, mix}`) for the dial; records everything to `replays/<date>.json`.
- Game: "Connect" panel (bridge URL + token), Live mode, load dial, a "measured vs sim"
  readout.
- In **gpu-inference**: `make game` (starts the port-forwards and the bridge from the arcade
  repo path), and `make evidence` additionally saves the bridge recording. No manifests change.
- **Done when:** cross-over effects 1–3 are demonstrated live and recorded as a replay plus
  screenshots in `docs/live/`.

### Phase 5 — Game → cluster, guarded (2 sessions, ~2 h cluster time)

- Bridge gains `POST /scale {replicas}` and `POST /knob {max_num_seqs | kv_dtype}` (the
  latter is a rolling restart), each enforced by a guard config: max replicas, max $/h,
  TTL auto-scale-down, and a dry-run mode.
- Game: "open a machine" and lever changes drive the real cluster in Live mode; the crane's
  boot bar is the real pod.
- **Sentinel**: a custom skill in gpu-inference's `.sentinel/skills/` that reviews any change
  to the guard limits and the bridge's mutation surface; Sentinel's runtime credits need
  topping up first (owner action). Until then, `/code-review` here.
- Optional: in-cluster bridge manifest under `platform/addons/game-bridge/` (kustomize),
  applied only with `GAME=1`, so a shared demo doesn't need a laptop.
- **Done when:** cross-over effect 4 works with the guard proven (a refused over-budget
  scale is part of the demo), and teardown verification stays zero-orphan.

### Phase 6 — Stretch

- **Calibration sweep**: `make game-profile` runs concurrency 1→64 against the live engine
  and fits the two numbers behind the wheel (base + per-sequence), so the sim is a fitted
  digital twin of *your* cluster; predicted vs measured plot in the game.
- Multi-pool: the l4x4 pipeline-parallel profile as a "four-stage machine".
- Multiplayer endless (shared leaderboard), GKE pool when billing exists.

---

## Repo layout

```
inference-arcade/
  PLAN.md                 this file
  README.md
  index.html              Pages landing (links game, replay, prototype)
  game/                   Phase 1+: renderer (PixiJS), sim, levels, assets
  sim/                    headless bots and balance tests (node)
  replays/                recorded runs in the state schema
  bridge/                 Phase 4+: FastAPI bridge (metrics → schema, chat proxy, load, guards)
  prototypes/             token-kitchen.html (superseded, kept for the engine)
  docs/                   demo notes, playtest notes, live-session evidence
```

## Connection to gpu-inference (what lands where)

| Change | Repo | Phase |
|---|---|---|
| `make game` target + `scripts/game.sh` (port-forwards + launches bridge) | gpu-inference | 4 |
| `make evidence` saves the bridge recording | gpu-inference | 4 |
| README link: "play the model behind this platform" | gpu-inference | 3 |
| `.sentinel/skills/game_bridge_guardrails.md` | gpu-inference | 5 |
| `platform/addons/game-bridge/` (optional, `GAME=1`) | gpu-inference | 5 |
| `make game-profile` calibration sweep | gpu-inference | 6 |
| bridge, game, replays, converter | inference-arcade | 3–5 |

Every gpu-inference change goes in as its own small PR with a preview first; evidence PRs
stay separate from code PRs (repo convention).

## Risks and open questions

- **Fun is the risk, not the tech.** Phase 1 is deliberately small so the verb can change.
- **Browser → cluster**: the bridge handles CORS and auth; the public page never talks to the
  cluster directly. Live mode needs the bridge URL, so it is a local/demo feature, not public.
- **Metric latency**: vLLM `/metrics` is cheap to scrape at 1 Hz; DCGM via Prometheus is 15 s.
  Heat glow can lag; rails/tank will not.
- **Cost**: live phases budget ~4 h of L4 time total (< $5). Scale-up tests use the 64-vCPU
  quota (up to 4 L4s), capped by the guard.
- **Sentinel credits**: owner action; not a blocker for phases 1–4.
- Name of the game (Tokenworks is a working title).
