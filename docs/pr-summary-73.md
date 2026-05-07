# PR Summary — Issue #73

## Summary

Quality checks were failing on CI because the `Run unit tests` step in
`.github/workflows/quality.yml` (and the equivalent step in `.github/workflows/deno-quality.yml`)
invoked `deno test` without `--allow-net`. The `@stsoftware/neat-ai` WASM activation module fetches
its remote payload from `jsr.io` at runtime, so every test that constructs a creature died with
`NotCapable: Requires net access to "jsr.io:443"`, producing 60 test failures in a single CI run.

The fix adds `--allow-net` and `--allow-ffi` to both workflow test steps so they match the local
`quality.sh` invocation, and tops up the `docs/archive_test.ts` allowlist with the recently added
`pr-summary-70.md` and the newly created `pr-summary-73.md`. A new `workflow_permissions_test.ts`
guards against the same regression by parsing the workflow YAML and asserting the required flags
remain present.

Closes #73.

## Evidence

This is a CI-configuration fix with no UI surface, so no Playwright screenshot is included.

Local reproduction before the fix (matching the CI invocation):

```text
$ deno test --no-check --allow-read --allow-write --allow-env
…
Failed to initialise WASM activation module: NotCapable:
  Requires net access to "jsr.io:443", run again with the --allow-net flag
…
FAILED | 254 passed | 60 failed (1s)
```

After the fix (matching the updated workflow invocation):

```text
$ deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-ffi
…
ok | 319 passed | 0 failed (4s)
```

```mermaid
flowchart LR
    A[CI runner] -->|deno test| B{permissions}
    B -- before --> C[NotCapable: jsr.io:443<br/>60 tests fail]
    B -- after --allow-net,--allow-ffi --> D[WASM module loads<br/>319 tests pass]
```

## Test Plan

- Added `workflow_permissions_test.ts` with 5 tests asserting that `quality.yml`,
  `deno-quality.yml`, and `quality.sh` invoke `deno test` with both `--allow-net` and `--allow-ffi`.
- Updated `docs/archive_test.ts` allowlist so `pr-summary-70.md` and `pr-summary-73.md` are accepted
  in the `docs/` root pending archival.
- Re-ran the full unit test suite locally with the new flags: `319 passed | 0 failed`.
