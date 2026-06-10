import { assert } from "@std/assert";

/**
 * Verify the repository ships a SECURITY.md posture document (Issue #574).
 *
 * SECURITY.md is the incident-readiness anchor: it must name a disclosure
 * contact and document the emergency dependency-bump procedure so a reporter
 * knows who to tell and how the team fast-tracks a fix. These are "what" tests
 * — they assert on the published artefact's content, which is the deliverable.
 */

const SECURITY_PATH = "SECURITY.md";

function readSecurity(): string {
  return Deno.readTextFileSync(SECURITY_PATH);
}

Deno.test("SECURITY.md exists at the repository root", () => {
  assert(Deno.statSync(SECURITY_PATH).isFile, "Expected SECURITY.md to be a file");
});

Deno.test("SECURITY.md names a disclosure contact", () => {
  const text = readSecurity().toLowerCase();
  assert(
    text.includes("service@stsoftware.com.au"),
    "Expected SECURITY.md to name the disclosure contact email",
  );
  assert(
    /disclos|report|vulnerab/.test(text),
    "Expected SECURITY.md to describe how to report a vulnerability",
  );
});

Deno.test("SECURITY.md documents the emergency-bump procedure", () => {
  const text = readSecurity();
  assert(
    text.includes("VIBE_BUMP_QUARANTINE_HOURS=0"),
    "Expected SECURITY.md to document the quarantine override knob",
  );
  assert(
    text.includes("bump-deps.sh"),
    "Expected SECURITY.md to reference ./bump-deps.sh",
  );
  assert(
    text.includes("quality.sh"),
    "Expected SECURITY.md to reference ./quality.sh before merging",
  );
});
