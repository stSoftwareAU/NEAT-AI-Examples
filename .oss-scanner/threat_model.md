# Threat model

Short brief for the scanner. Reporting and the emergency dependency-bump procedure are in
[SECURITY.md](../SECURITY.md); contributor conventions are in [AGENTS.md](../AGENTS.md).

## What this project does and where untrusted input enters

NEAT-AI-Examples is a set of runnable Deno demo programs for the NEAT-AI library
(`jsr:@stsoftware/neat-ai`): XOR, cart-pole, lunar lander, MNIST, TSP, stock-market direction and so
on. Each example is started locally by a developer through its `run.sh`, trains a creature, and
writes JSON and SVG artefacts under `.synthetic-*/` and `docs/`. There is no server, no network
listener, no authentication and no user data, so the attack surface is small and we rate most
findings low. The inputs worth treating as untrusted are:

- datasets downloaded by `common/data_cache.ts` (MNIST from `storage.googleapis.com`, S&P 500 prices
  from `raw.githubusercontent.com`), which are SHA-256 pinned;
- saved creatures and multi-run state read back from `.synthetic-*/` on resume;
- command-line flags and the environment variables each `run.sh` allowlists.

## Components that matter most / least

Most important:

- `common/data_cache.ts`: digest verification, atomic `.part` rename, mirror fallback and the stall
  timeout; a bypass that lets unverified bytes reach a cache hit matters;
- the scoped Deno permissions in each `*/run.sh` and `common/example_runner_preamble.sh`
  (`--allow-net` hosts, `--allow-env` and `--allow-run` lists), which are the sandbox;
- SVG emitters and `common/svg_text.ts` escaping, since the SVGs are committed and rendered on
  GitHub;
- `bump_deps.ts` and `.github/workflows/`, which update dependencies with CI credentials.

Lower priority: the training logic and simulators inside each example directory (deterministic
numeric code on local data), `docs/` prose and `quality/` campaign scripts. NEAT-AI itself lives in
a separate repository; report library bugs only through how these examples call it.

## How to exercise it

From `/src`: `deno test --frozen --no-check -A --reporter=dot` runs the unit suite (quality.sh runs
`mnist_classification/evolve_integration_test.ts` and `exploration_campaign_driver_test.ts`
separately, one `--filter` per process). `deno check .` type-checks everything. Each example has a
quick mode, for example `XOR_QUICK=1 ./xor_classification/run.sh`; `quality.sh` lists them all. The
image caches the NEAT-AI WASM bundle in `NEAT_AI_WASM_CACHE_DIR` and pre-downloads the datasets, but
the `run.sh` wrappers do not allowlist that variable, so offline you should start an example with
`deno run -A <dir>/<example>.ts` instead. The optional NEAT-AI-Discovery library and NEAT-AI-scorer
binary are not in the image; those paths skip or fall back to WASM.

## How you rate severity

- High: a dataset or creature file that runs code or escapes the scoped Deno permissions, a digest
  check that can be bypassed, or a workflow change that exposes CI secrets.
- Medium: script or markup injection into a committed SVG, or writes outside the working tree.
- Low: denial of service from a malformed local file, excessive memory or CPU in training, and
  anything that needs the developer's own machine or flags to be hostile.

## Anything to leave alone

- Examples are demos, not hardened services; long training runs, large heaps and `--allow-write` are
  by design.
- Committed `docs/data/` and `docs/screenshots/` artefacts are generated output.
