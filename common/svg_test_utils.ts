/**
 * Shared SVG inspection helpers for tests.
 *
 * Attribute lookups use hardcoded regexes and plain string comparison
 * rather than a regex built from the caller's `className`/`attribute`,
 * so no caller-supplied text ever reaches the regex engine (ReDoS).
 */

/** Matches any opening tag, e.g. `<rect ... >`. */
const TAG_PATTERN = /<[a-z]+\b[^>]*>/g;

/** Matches one `name="value"` attribute pair within a tag. */
const ATTRIBUTE_PATTERN = /([a-zA-Z_:][\w:.-]*)="([^"]*)"/g;

/** Parse a single opening tag into its attribute map. */
function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name, value] of tag.matchAll(ATTRIBUTE_PATTERN)) {
    attributes.set(name, value);
  }
  return attributes;
}

/**
 * Read `attribute` from the first element carrying `className` in its
 * class list. Lets colour assertions name a semantic hook instead of a
 * hex literal.
 */
export function attributeForClass(
  svg: string,
  className: string,
  attribute: string,
): string | undefined {
  for (const [tag] of svg.matchAll(TAG_PATTERN)) {
    const attributes = attributesOf(tag);
    const classes = attributes.get("class")?.split(/\s+/) ?? [];
    if (!classes.includes(className)) continue;
    return attributes.get(attribute);
  }
  return undefined;
}

/** Read the `fill` of the first element tagged with `className`. */
export function fillForClass(
  svg: string,
  className: string,
): string | undefined {
  return attributeForClass(svg, className, "fill");
}

/** Read the `stroke` of the first element tagged with `className`. */
export function strokeForClass(
  svg: string,
  className: string,
): string | undefined {
  return attributeForClass(svg, className, "stroke");
}
