/**
 * Shared XML escaping and deterministic number formatting for the SVG
 * emitters under `common/`.
 *
 * Every SVG-emitting module encodes the same two rules (issue #778):
 *
 *   - **XML escaping** — `&`, `<` and `>` in element text, plus `"`
 *     inside a double-quoted attribute. `&` is escaped first so the
 *     entities introduced by the later replacements are not
 *     double-escaped.
 *   - **Deterministic formatting** — coordinates round to two decimal
 *     places and scores to three, with non-finite values degrading to
 *     `"0"`, so identical inputs produce byte-identical output.
 *
 * Both rules must hold identically across every renderer, so they live
 * here once rather than being copied into each one.
 *
 * Pure string functions — no DOM, no dependencies.
 */

/** Round a numeric coordinate to two decimal places for compact, deterministic output. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 100) / 100).toString();
}

/** Format a score, error or axis tick value to three decimal places. */
export function formatScore(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 1000) / 1000).toString();
}

/** Escape XML metacharacters for use in element text content. */
export function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape XML metacharacters for use inside a double-quoted attribute. */
export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
