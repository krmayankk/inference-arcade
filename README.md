# Inference Arcade

An arcade game that is also an honest picture of how GPUs serve large language models —
and that can be plugged into a real cluster so the game and the cluster move each other.

- **Play:** https://krmayankk.github.io/inference-arcade/game/ — Tokenworks (Phase 1: three levels + endless)
- **Watch a bot play:** https://krmayankk.github.io/inference-arcade/game/?bot=1&lvl=2&x=1
- **Plan:** [PLAN.md](PLAN.md) — the game design, the metric → game-piece mapping, and the phases
- **The cluster it connects to:** [gpu-inference](https://github.com/krmayankk/gpu-inference)
  (vLLM serving Qwen on EKS; the L4 numbers in the game are measured there)

## The story (how the game maps to GPU inference)

A machine makes replies for people, one word at a time.

- **A capsule is a person asking a question.** The ribbon behind it is how long their question is.
  The ring around it is their patience; when it runs out they give up and leave.
  *Real: one request, prompt length, client timeout.*
- **Your cannon decides who goes where.** You shoot each person onto a machine. That is all a
  dispatcher does. *Real: the router picks a GPU replica for each request.*
- **A rail is a seat on the machine.** One person per seat. The wheel turns, and every turn gives
  every seated person one more word. The sparks off the right are those words; a finished reply pays.
  *Real: a batch slot (`max_num_seqs`); one decode step per turn; one token per sequence per step.*
- **Adding rails is adding seats.** A turn takes almost the same time with eight seats as with one,
  so more seats serve more people nearly for free. *Real: decode is memory-bound; the weights stream
  once per step whatever the batch size. 34.7 ms per step on an L4, measured.*
- **The tank is the machine's memory.** Every seated person takes some, and more as their reply
  grows. A full tank pushes the newest person off their seat, back into the lane. *Real: the KV
  cache, paged in 16-token blocks; preemption.*
- **Gold in the tank is a question the machine has already read.** Same colour, same question
  start. Same colour to the same machine is nearly free; a new colour makes the reader grind and
  everyone on that machine waits. *Real: prefix caching; prefill is compute-bound and stalls decode.*
- **Batch lock** is the old rule: nobody sits down until everyone seated has finished. Flip it and
  seats refill the moment one empties. *Real: static vs continuous batching.*
- **A giant** is an enormous question that freezes the machine while it is read, unless you chop it
  so the wheel keeps turning between pieces. *Real: chunked prefill.*
- **Turning someone away** on purpose beats letting five more time out. *Real: request shedding.*
- **Rent** is what the machine costs per hour, seated or empty. *Real: $0.98/h for an L4; cost per
  million tokens is rent divided by words produced.*

Press **X** in the game and every piece shows its real name and the metric behind it.

### Lessons for running GPUs well, in the game's words

1. **Fill the seats.** An idle wheel turn costs the same as a full one. Batch size is the first lever.
2. **Keep the same colours together.** Prefix-aware routing turns a multi-second read into nothing.
3. **Watch the tank, not the wheel.** Memory, not compute, is what runs out first in decode.
4. **Never lock the batch.** Continuous batching is the single biggest throughput win.
5. **Chop the giants.** One long prompt should never freeze everyone else.
6. **Turn people away early.** A shed request costs nothing; a timed-out one cost a seat for nothing.
7. **Count the rent.** Cost per million tokens is the number that decides whether a GPU is worth it.

## What's here

| Path | What |
|---|---|
| `game/` | Tokenworks: `sim.js` (the engine, pure JS, runs in node too), `main.js` (PixiJS renderer + input), `index.html` |
| `sim/arcade-bots.js` | headless bots that play every level the naive way and the intended way; a level is balanced when naive loses and intended wins |
| `sim/headless/` | bot driver + screenshot script for checking the game renders without a browser session |
| `docs/phase-1.md` | what Phase 1 built, the numbers behind it, bot results, the playtest checklist |
| `prototypes/token-kitchen.html` | the first prototype (kitchen metaphor), kept for reference; `sim/bots.js` plays it |

Run the bots: `node sim/arcade-bots.js 3`
