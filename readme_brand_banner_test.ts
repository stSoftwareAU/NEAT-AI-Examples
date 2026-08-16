import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { existsSync } from "@std/fs";

/**
 * The root README must show this repository's NEAT-AI family social preview,
 * hot-linked from the hub (issue
 * [#803](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/803), parent
 * [NEAT-AI#3764](https://github.com/stSoftwareAU/NEAT-AI/issues/3764)).
 *
 * These are "what" tests: the published README is the artefact under test. The
 * hub owns the artwork and regenerates it in place, so siblings pull the raw
 * `Develop` URL rather than committing a copy.
 */

const README_PATH = "README.md";
const HUB_BANNER_URL =
  "https://raw.githubusercontent.com/stSoftwareAU/NEAT-AI/Develop/docs/brand/social-previews/neat-ai-examples.png";

/** Everything from the H1 title to the first `##` heading. */
function opening(markdown: string): string {
  const title = markdown.search(/^#\s+/m);
  assert(title >= 0, "README must start with an H1 title");
  const body = markdown.slice(title);
  const nextSection = body.search(/^##\s+/m);
  return nextSection < 0 ? body : body.slice(0, nextSection);
}

function bannerImages(markdown: string): { src: string; alt: string }[] {
  const images: { src: string; alt: string }[] = [];
  const html = /<img\b[^>]*>/gi;
  for (const match of markdown.matchAll(html)) {
    const tag = match[0];
    const src = tag.match(/\bsrc="([^"]+)"/i)?.[1];
    const alt = tag.match(/\balt="([^"]*)"/i)?.[1];
    if (src) images.push({ src, alt: alt ?? "" });
  }
  const md = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  for (const match of markdown.matchAll(md)) {
    images.push({ alt: match[1], src: match[2] });
  }
  return images;
}

Deno.test("root README opening shows the hub social preview", () => {
  const header = opening(Deno.readTextFileSync(README_PATH));
  const banners = bannerImages(header).filter((image) => image.src === HUB_BANNER_URL);

  assertEquals(
    banners.length,
    1,
    `${README_PATH} opening must embed exactly one hub banner at ${HUB_BANNER_URL}`,
  );
  assertStringIncludes(
    banners[0].alt,
    "NEAT-AI-Examples",
    "banner alt text must name this repository",
  );
  assert(
    banners[0].alt.trim().length > "NEAT-AI-Examples".length,
    "banner alt text must describe the project, not only name it",
  );
});

Deno.test("root README does not vendor a local copy of the family preview", () => {
  const readme = Deno.readTextFileSync(README_PATH);
  for (const image of bannerImages(readme)) {
    assert(
      !/^(?:\.\.\/|\.\/)?docs\/brand\//.test(image.src),
      `${README_PATH} must hot-link the hub preview, not a local path (found ${image.src})`,
    );
  }
  assertEquals(
    existsSync("docs/brand/social-previews/neat-ai-examples.png"),
    false,
    "siblings pull, they do not copy: docs/brand/social-previews/neat-ai-examples.png must not be committed here",
  );
});
