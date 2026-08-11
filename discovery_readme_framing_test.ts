import { assert, assertStringIncludes } from "@std/assert";

/**
 * The "science-driven structural mutation" framing on the two Discovery READMEs
 * (issue [#189](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/189), restored and
 * re-tested under [#797](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/797) after the
 * #207 / #208 rewrites replaced the opening sections wholesale and dropped it).
 *
 * These are "what" tests: the published READMEs are the artefacts under test. Each must open —
 * before its first `##` section — with prose contrasting textbook NEAT's blind random structural
 * mutation against NEAT-AI-Discovery's error-driven activation analysis, and
 * `docs/neat_ai_feature_audit.md` must agree that the framing is present.
 */

const READMES: Record<string, string> = {
  discovery: "discovery/README.md",
  discovery_at_scale: "discovery_at_scale/README.md",
};

const AUDIT_PATH = "docs/neat_ai_feature_audit.md";
const DISCOVERY_URL = "https://github.com/stSoftwareAU/NEAT-AI-Discovery";

/** The opening section of a README — everything from the `#` title to the first `##` heading. */
function intro(markdown: string): string {
  const title = markdown.search(/^#\s+/m);
  assert(title >= 0, "README must start with an H1 title");
  const body = markdown.slice(title);
  const nextSection = body.search(/^##\s+/m);
  return (nextSection < 0 ? body : body.slice(0, nextSection)).toLowerCase();
}

function readIntro(path: string): string {
  return intro(Deno.readTextFileSync(path));
}

for (const [name, path] of Object.entries(READMES)) {
  Deno.test(`${name} README opens with the science-driven structural mutation framing`, () => {
    const opening = readIntro(path);
    for (const phrase of ["science-driven", "structural mutation", "error-driven"]) {
      assertStringIncludes(
        opening,
        phrase,
        `${path} should frame Discovery as "${phrase}" before its first ## section`,
      );
    }
  });

  Deno.test(`${name} README contrasts the framing with textbook NEAT's random mutation`, () => {
    const opening = readIntro(path);
    for (const phrase of ["textbook neat", "random"]) {
      assertStringIncludes(
        opening,
        phrase,
        `${path} should contrast Discovery with textbook NEAT random mutation (missing ` +
          `"${phrase}")`,
      );
    }
  });

  Deno.test(`${name} README names the activation categories Discovery classifies`, () => {
    const opening = readIntro(path);
    for (const category of ["saturated", "dead", "dormant", "bimodal", "bottleneck"]) {
      assertStringIncludes(
        opening,
        category,
        `${path} should name the "${category}" activation category the analysis flags`,
      );
    }
  });

  Deno.test(`${name} README links NEAT-AI-Discovery from the framing`, () => {
    assertStringIncludes(
      readIntro(path),
      DISCOVERY_URL.toLowerCase(),
      `${path} should link ${DISCOVERY_URL} from its framing so readers can follow it upstream`,
    );
  });
}

Deno.test("audit no longer records the Discovery framing as absent", () => {
  const rows = Deno.readTextFileSync(AUDIT_PATH)
    .split("\n")
    .filter((line) => line.startsWith("|"));
  for (const row of rows) {
    if (!/discovery(_at_scale)?\/README\.md/.test(row)) continue;
    if (row.includes("Resolved")) continue; // Row already records the gap as closed.
    assert(
      !/\b(missing|absent)\b/i.test(row),
      `${AUDIT_PATH} still records the science-driven framing as missing for a Discovery README, ` +
        `but both READMEs now carry it: ${row.trim()}`,
    );
  }
});
