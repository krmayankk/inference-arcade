# Phase 2 — one PR per enhancement

The order and the honesty rule for each PR are in PLAN.md (Phase 2). This file records what each PR
actually changed and what the bots say.

## PR A — Honest pieces (2026-10-31)

Goal: a senior inference engineer can press X and find nothing fake.

- **X-ray is a mapping panel now, not a relabel.** Below the stage, every piece lists the metric it
  stands for, its current value, and its source: `measured` (gpu-inference Phase 1 on one L4),
  `estimated` (ratio estimates until the Phase 6 calibration sweep), `sim` (a counter the simulator
  keeps that the cluster reports the same way), `client` (a client-side quantity vLLM never sees), or
  `live only` (DCGM temperature/power/util: needs the Phase 4 bridge). Capsule in the lane = request
  not yet routed; at a gate = `vllm:num_requests_waiting`; on a track = `vllm:num_requests_running`;
  wheel turn = `vllm:inter_token_latency_seconds`; chute = `rate(vllm:generation_tokens_total)`;
  reader ring = `vllm:request_prefill_time_seconds`; tank = `vllm:kv_cache_usage_perc`; popped out =
  `vllm:num_preemptions_total`; gold bricks = `vllm:prefix_cache_hits_total / queries_total`.
- **Capsule = one request = one sequence**, said in the legend and the first coach line.
- **Prefix cache is LRU, not a timer.** A cached prefix stays in the tank until the tank needs the
  blocks; then the least recently used prefix nobody is using goes first, and only after that does
  the newest sequence get preempted (vLLM's block-manager order). Level 3 keeps its routing lesson
  through *prefix churn*: a new prompt family arrives and an old one retires every 18 s, so every
  new colour costs exactly one cold read if routed sticky, and about two if routed at random.
- **Rent.** Every machine accrues its real instance price ($0.98/h for the L4) over game time; the
  HUD shows cost per 1M generated tokens = $/h ÷ (tok/s × 3600 / 1e6), the same formula as the
  cluster evidence. One L4 serving a 7B model at a few tokens per second costs dollars per million
  tokens; at 8 busy rails it drops under $3. That is the batching lesson in money.
- **Every GPU number carries a flag.** `measured`: base step (34.7 ms from 28.8 tok/s) and price.
  `estimated`: per-sequence step cost, prefill rate, KV capacity, boot time.

Bot results (`node sim/arcade-bots.js 4`): level 3 random / round-robin 62–70% on time (bar 70%,
so a rare scrape), colour affinity 72–82%, affinity with 12 rails 76–90%. Levels 1–2 unchanged.

What is still simplified, on purpose, and where it gets fixed: per-sequence step cost and prefill
rate are estimates (Phase 6); the lane's patience is a client timeout, not a vLLM queue limit; there
is no scheduler priority beyond arrival order (vLLM default).
