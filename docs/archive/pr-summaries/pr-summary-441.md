# Supply-chain quarantine for `bump-deps.sh`

## Summary

Closes #441.

The previous `bump-deps.sh` ran `deno update --latest` with no minimum-release-age gate. A
compromised JSR maintainer (or any `@std/*` / npm publisher in `deno.json`) could publish a
malicious version at T+0 and have it auto-bumped onto Develop within minutes by the
`deno-outdated.yml` workflow. This PR closes that window.

Replaced the bare `deno update --latest` call with a new quarantine-aware updater, `bump_deps.ts`,
that:

- Queries the registry (`npm.jsr.io` for `jsr:` pins, `registry.npmjs.org` for `npm:` pins) for each
  pinned import's publish timestamps.
- Refuses to bump an **external** pin to a version younger than `VIBE_BUMP_QUARANTINE_HOURS` hours
  (default 24 h).
- Lets **internal** `@stsoftware/*` packages bump immediately — internal NEAT-AI / tags releases are
  expected to land without delay per the project supply-chain policy.
- Skips yanked / deprecated versions and never downgrades.

`bump-deps.sh` now delegates to that updater and then runs `deno install` to refresh `deno.lock`.
The auto-bump workflow (`deno-outdated.yml`) pins `VIBE_BUMP_QUARANTINE_HOURS: "24"` at the job
level so the policy stays auditable from the CI config.

## Flow

```mermaid
flowchart LR
    A[PR opened against Develop] --> B[deno-outdated.yml]
    B --> C[bump-deps.sh]
    C --> D[bump_deps.ts]
    D -->|jsr:| E[npm.jsr.io metadata]
    D -->|npm:| F[registry.npmjs.org metadata]
    E --> G{Internal scope?}
    F --> G
    G -->|@stsoftware/*| H[Bump immediately]
    G -->|external| I{Latest ≥ 24h old?}
    I -->|yes| H
    I -->|no| J[Keep current pin]
    H --> K[Write deno.json]
    J --> K
    K --> L[deno install refresh deno.lock]
    L --> M[Commit + push to PR head]
```

## Evidence

This is a backend / CLI change with no UI to screenshot.

Verified end-to-end against the live registry in dry-run mode (`deno run … bump_deps.ts --dry-run`).
The script kept every external `@std/*` pin (no newer version has cleared the 24 h quarantine) and
identified `@stsoftware/neat-ai 5.0.28 → 5.0.29` as the only bump permitted by policy — exactly the
carve-out the issue requires.

Unit tests (`bump_deps_test.ts`) exercise the real exported functions against an injected fetcher —
no network is touched at test time. The suite cover the quarantine filter, internal-vs-external
classification, the never-downgrade rule, yanked / pre-release skips, the registry URL shape,
end-to-end `bumpDenoConfig` on a temp file, and the dry-run guarantee.

A new workflow test (`.github/deno_outdated_workflow_test.ts`) asserts the workflow pins
`VIBE_BUMP_QUARANTINE_HOURS` so a future edit that drops the env var fails CI.

## Test plan

- `deno test --no-check --allow-read --allow-write --allow-env --allow-net bump_deps_test.ts` — 29
  new tests, all pass.
- `deno test --no-check --allow-read --allow-write --allow-env --allow-net .github/deno_outdated_workflow_test.ts`
  — 6 workflow tests, all pass (5 pre-existing + 1 new quarantine-env test).
- `deno fmt`, `deno lint`, `deno check bump_deps.ts bump_deps_test.ts` — clean.
- Manual dry-run of `bump_deps.ts` against the live JSR / npm registries — produced the expected
  `keep` / `BUMP` output for the current `deno.json`.

## Files

- `bump_deps.ts` — new quarantine-aware updater.
- `bump_deps_test.ts` — unit tests for the updater.
- `bump-deps.sh` — now delegates to `bump_deps.ts` and refreshes `deno.lock` via `deno install`.
- `.github/workflows/deno-outdated.yml` — pins `VIBE_BUMP_QUARANTINE_HOURS: "24"` at job level.
- `.github/deno_outdated_workflow_test.ts` — asserts the env var is pinned.
