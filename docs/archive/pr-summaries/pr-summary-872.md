## Summary

`scripts/mnist_lamarck_backprop_campaign.sh` launched `scripts/mnist_holdout_score.ts` with bare
`--allow-net --allow-env --allow-sys`. It was the only entry point in the repo that skipped the
least-privilege Deno policy from #419. Both calls (`holdout()` and `promote_if_better()`) now use
one scoped `HOLDOUT_DENO_FLAGS` array:

- `--allow-env=` the same allowlist as `NEAT_AI_ENV_VARS` in `common/example_runner_preamble.sh`.
- `--allow-net=storage.googleapis.com,jsr.io`: the MNIST dataset host plus NEAT-AI's WASM payload.
  These are the same hosts `mnist_classification/run.sh` allows.
- `--allow-sys=systemMemoryInfo,hostname`, the same as `NEAT_EXAMPLE_ALLOW_SYS`.
- `--no-prompt`, so a denied permission fails loudly instead of waiting on a prompt.

The scorer's usage comment no longer recommends `deno run -A`.

Closes #872.

## Evidence

This is a CLI/script change with no UI, so there is no screenshot.

- **Regression test:** added
  `scripts/mnist_lamarck_backprop_campaign_test.ts::campaign launches the hold-out scorer with scoped Deno permissions`.
  - It runs the real campaign script for one cycle inside a temporary repository layout. A stub
    `deno` sits first on `PATH` and records its argv. Stub Lamarck and Backprop binaries stand in
    for the real ones.
  - It covers both code paths: the baseline, post-slice and final hold-out runs, and the `--compare`
    promotion gate.
  - It checks that every `deno` call:
    - grants no bare `-A`, `--allow-all`, `--allow-net`, `--allow-env` or `--allow-sys`
    - passes `--no-prompt`
    - allows only `storage.googleapis.com` and `jsr.io` on the network
    - allows only `systemMemoryInfo` and `hostname` sys APIs
    - has a non-empty `--allow-env` allowlist with no secret-bearing names in it
- **Fails before, passes after:** against the unfixed script the test failed with
  `deno run --allow-read --allow-write --allow-net --allow-env --allow-sys … grants bare --allow-net`.
  It passes after the fix.
- **Scoped flags still work:** the real scorer ran with exactly these flags against
  `docs/data/mnist_classification/creature.json` in `--compare` mode. The MNIST cache was empty, so
  it did a fresh download as well. It printed the usual JSON (`testAccuracy` 0.3068,
  `validationAccuracy` 0.31), and no permission was denied.
- **Original trigger is closed:** running `./scripts/mnist_lamarck_backprop_campaign.sh` now starts
  every `deno run` through `HOLDOUT_DENO_FLAGS`. The script has no other `deno` call site, so there
  is no remaining path that grants bare net, env or sys access. `--no-prompt` also stops an
  interactive prompt from widening permissions at run time. So a compromised dependency in the
  scorer's import graph can no longer read unlisted env vars (e.g. `GITHUB_TOKEN`) or reach any host
  other than the two above.

## Security self-check

- [x] Input validation: no new external input.
- [x] Secrets: none staged. The env allowlist has no secret-bearing names.
- [x] Injection surface: no new shell or string interpolation. Flags are a fixed array.
- [x] Dependencies: none added.

## Test Plan

- `deno test --allow-read --allow-write --allow-env --allow-run=bash scripts/mnist_lamarck_backprop_campaign_test.ts`
- `shellcheck scripts/mnist_lamarck_backprop_campaign.sh`, `deno fmt --check`, `deno lint`
- `./quality.sh < /dev/null`
