# PR Summary — Issue #811

## Summary

The `audit` job in `.github/workflows/deno-audit.yml` checked the repository out
without `persist-credentials: false`, so `actions/checkout` wrote the workflow
`GITHUB_TOKEN` into `.git/config` as an auth header where any later step in the
job could read it back and act as the token.

The job runs `deno audit --frozen` over the checked-out lockfile only — it never
pushes back to the repository and fetches no private submodule — so the
persisted credential buys nothing and only widens the blast radius of a
compromised step. The checkout now sets `persist-credentials: false`, matching
every other workflow in this repository (`quality.yml`, `semgrep.yml`,
`gitleaks.yml`, `actionlint.yml`, `markdown-lint.yml`, `deno-outdated.yml`,
`deno-security-update.yml`).

Closes #811.

## Evidence

Backend/CI change — there is no web interface to screenshot. The deliverable is
the workflow YAML, so the evidence is the new parsing test observed red against
the unfixed workflow and green after the fix.

Before the fix (`deno test --allow-read deno_audit_workflow_credential_test.ts`):

```text
[Diff] Actual / Expected
-   undefined
+   false
FAILED | 1 passed | 1 failed (18ms)
```

After the fix:

```text
deno-audit.yml audit job — every checkout drops the credential ... ok (3ms)
deno-audit.yml audit job — no step pushes back to the repository ... ok (644µs)
ok | 2 passed | 0 failed (6ms)
```

Credential flow before and after:

```mermaid
flowchart LR
    subgraph before["Before — token persisted"]
        A1[actions/checkout] -->|writes auth header| B1[.git/config]
        B1 -.->|readable by| C1[deno audit step]
    end
    subgraph after["After — persist-credentials: false"]
        A2[actions/checkout] -->|no auth header written| B2[.git/config]
        C2[deno audit step] -.->|nothing to read| B2
    end
```

## Test Plan

- Added `deno_audit_workflow_credential_test.ts`:
  - `deno-audit.yml audit job — every checkout drops the credential` — parses
    the workflow YAML and asserts every `actions/checkout` step in the `audit`
    job sets `persist-credentials: false`. Fails against the unfixed workflow.
  - `deno-audit.yml audit job — no step pushes back to the repository` — guards
    the premise of the fix, so a future step that pushes forces the trade-off to
    be re-assessed rather than silently breaking.
- Ran `deno fmt --check` and `deno lint` on the new test file — both clean.
- Ran `./quality.sh` (full gate).
