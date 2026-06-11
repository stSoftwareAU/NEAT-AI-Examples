# PR Summary — Add SECURITY.md posture document (Issue #574)

## Summary

The repository had **no `SECURITY.md`** at any standard location, and `CONTRIBUTING.md` named
neither a disclosure contact nor an emergency-bump procedure — leaving no documented way for a
reporter to reach the maintainers or fast-track a dependency fix during an incident.

This PR adds a short `SECURITY.md` at the repo root that:

1. Names a **disclosure contact** — `service@stsoftware.com.au` — and asks reporters to disclose
   privately.
2. Documents the **emergency dependency-bump procedure**: fast-track a security fix past the 24h
   supply-chain quarantine with `VIBE_BUMP_QUARANTINE_HOURS=0 ./bump-deps.sh`, then `./quality.sh`
   before merging. This also makes the quarantine-override path explicit rather than implicit in the
   `bump-deps.sh` comment.

Closes #574.

## Evidence

This is a documentation/CLI change with no web interface, so there is no screenshot. The new
`SECURITY.md` is verified by automated tests (below) that assert on its published content.

Incident-readiness flow documented in the new file:

```mermaid
flowchart LR
    R["🚨 Suspected issue"] --> C["📣 Email service@stsoftware.com.au"]
    C --> Q["🚑 VIBE_BUMP_QUARANTINE_HOURS=0 ./bump-deps.sh"]
    Q --> V["✅ ./quality.sh passes"]
    V --> M["🔀 Commit & merge fix"]
```

Validation run:

- `deno test --allow-read security_md_test.ts` — 3 passed.
- `deno fmt --check` — 464 files clean.
- `deno lint` — 166 files clean.
- `markdownlint-cli2 SECURITY.md` — 0 errors.

## Test Plan

Added `security_md_test.ts` (root) with three "what" tests asserting on the deliverable artefact:

- `SECURITY.md exists at the repository root` — confirms the file is present.
- `SECURITY.md names a disclosure contact` — asserts the disclosure email and report wording.
- `SECURITY.md documents the emergency-bump procedure` — asserts `VIBE_BUMP_QUARANTINE_HOURS=0`,
  `bump-deps.sh`, and `quality.sh` are all referenced.

The tests fail against the unfixed tree (no `SECURITY.md`) and pass after the file is added.
