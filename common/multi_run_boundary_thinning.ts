/**
 * Shared run-boundary label thinning policy for the multi-run SVG renderers.
 *
 * Multi-run examples can accumulate dozens or hundreds of run boundaries
 * (see issue #514 — 115 runs across ~5650 generations on a log-x axis).
 * Drawing one tick + `run N` label per boundary collapses into an
 * unreadable smear, so the shared `./chart_run_boundaries.ts` emitter
 * used by both `multi_run_error_chart.ts` and
 * `multi_run_complexity_chart.ts` routes its boundary rendering through
 * {@link selectBoundaryIndices}: it picks the indices of the boundaries
 * that should actually receive a visible tick + label.
 *
 * Policy (from issue #521):
 *
 *   1. **Auto-fit.** Estimate label width from the longest `"run N"`
 *      string at font-size 10 (≈6.5 px per character is a safe
 *      deno-side estimate) and pick the largest stride `k` such that
 *      `ceil(totalBoundaries / k) * estimatedLabelWidth <= plotW * 0.9`.
 *   2. **Cap.** Never show more than 10 boundary labels.
 *   3. **Anchors.** The first and last run-boundary transition must
 *      always be in the selected set; intermediate picks are evenly
 *      spaced.
 *   4. **Ticks follow labels.** Callers only render a boundary tick
 *      where a label is drawn — bare ticks are never emitted.
 *   5. **≤10 boundaries.** Every boundary keeps its label/tick
 *      regardless of plot width — guarantees byte-identical output
 *      for low-run-count campaigns (acceptance criterion).
 */

/**
 * Maximum boundary labels the policy will ever emit, even when more
 * would technically fit at the default 800 px width.
 */
export const MAX_BOUNDARY_LABELS = 10;

/**
 * Estimated width in pixels of a single character at font-size 10
 * sans-serif. Empirically a safe upper-bound on a Deno-side render
 * (no DOM is available to measure exactly).
 */
export const ESTIMATED_CHAR_WIDTH_PX = 6.5;

/**
 * Fraction of the plot width that label text is allowed to occupy.
 * The remaining 10 % gives the leftmost and rightmost labels room to
 * extend past the boundary tick they sit above.
 */
export const PLOT_WIDTH_USABLE_FRACTION = 0.9;

/**
 * Select the indices of the run boundaries that should receive a
 * visible tick + label.
 *
 * @param boundaryCount Number of run-boundary transitions detected in
 *   the milestone series. Boundary `i` corresponds to the i-th
 *   transition in cumulative order.
 * @param plotWidth Width of the plot area in user units.
 * @param longestLabelChars Length of the longest `"run N"` label that
 *   would be emitted. Used to estimate label width.
 * @returns Sorted, deduplicated array of boundary indices to render.
 *   Empty when `boundaryCount === 0`. Always includes the first (`0`)
 *   and last (`boundaryCount - 1`) indices when `boundaryCount >= 1`.
 */
export function selectBoundaryIndices(
  boundaryCount: number,
  plotWidth: number,
  longestLabelChars: number,
): number[] {
  if (boundaryCount <= 0) return [];
  if (boundaryCount === 1) return [0];

  // Low-run-count short-circuit: ≤10 boundaries keeps every label, so
  // a 1–10 run campaign renders byte-identically to the pre-#521
  // implementation. The width check is intentionally skipped here —
  // the cap itself comfortably fits at the default 800 px plot width
  // (10 × "run 10" ≈ 390 px <= 720 px).
  if (boundaryCount <= MAX_BOUNDARY_LABELS) {
    return rangeIndices(boundaryCount);
  }

  // Auto-fit: how many labels can sit side-by-side without overlap?
  const labelWidth = Math.max(1, longestLabelChars) * ESTIMATED_CHAR_WIDTH_PX;
  const usableWidth = Math.max(0, plotWidth) * PLOT_WIDTH_USABLE_FRACTION;
  const maxByWidth = Math.max(1, Math.floor(usableWidth / labelWidth));

  // Apply the cap and clamp to the available boundary count.
  const numLabels = Math.min(boundaryCount, MAX_BOUNDARY_LABELS, maxByWidth);

  if (numLabels >= boundaryCount) {
    return rangeIndices(boundaryCount);
  }
  if (numLabels <= 1) {
    // Degenerate width — still anchor on the last boundary so the
    // viewer can read "run N" for whatever the final run was.
    return [boundaryCount - 1];
  }

  // Evenly distribute `numLabels` indices across `[0, boundaryCount - 1]`,
  // anchored at both ends. `Math.round` of the linear interpolation
  // gives an integer position for each label; deduplication via Set
  // guards against rounding collisions when `numLabels` is close to
  // `boundaryCount`.
  const indices = new Set<number>();
  for (let j = 0; j < numLabels; j++) {
    const idx = Math.round((j * (boundaryCount - 1)) / (numLabels - 1));
    indices.add(idx);
  }
  return [...indices].sort((a, b) => a - b);
}

function rangeIndices(n: number): number[] {
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

/**
 * Second-pass, position-aware collision filter for already-selected
 * boundary labels.
 *
 * {@link selectBoundaryIndices} spaces labels evenly by boundary
 * *index*, which assumes the boundaries are spread evenly across the
 * plot. On a log-X cumulative-generation axis (issue #514) the later
 * runs add only a handful of generations each, so their boundaries
 * cluster against the right edge and the index-even labels still
 * overlap. This pass takes the final pixel positions of the selected
 * labels and greedily drops any that would collide horizontally, while
 * guaranteeing the first and last labels (the anchors) always survive.
 *
 * @param labels Pixel positions of the candidate labels, sorted by `x`.
 *   `width` is the rendered label width in user units.
 * @returns Indices (into `labels`) to keep — strictly increasing, with
 *   the first and last entries always present and no two kept labels
 *   overlapping horizontally. The first/last anchors are kept even if
 *   they overlap each other (there is nothing to drop between them).
 */
/**
 * End-to-end boundary selection for the multi-run renderers: pick the
 * evenly-spaced candidate labels via {@link selectBoundaryIndices}, then
 * — only when the index-even policy actually thinned (more than
 * {@link MAX_BOUNDARY_LABELS} boundaries) — run the position-aware
 * {@link dropCollidingLabels} pass so labels that bunch up on a log-X
 * axis do not overlap.
 *
 * The collision pass is intentionally skipped for ≤10-boundary
 * campaigns so their SVGs stay byte-identical to the pre-#521 output
 * (acceptance criterion of issue #522).
 *
 * @param boundaries Run-boundary transitions in cumulative order.
 * @param plotWidth Plot-area width in user units.
 * @param longestLabelChars Length of the longest `"run N"` label.
 * @param xScale Maps a cumulative-generation value to its pixel X.
 * @returns Set of boundary indices that should receive a tick + label.
 */
export function selectVisibleBoundaryIndices(
  boundaries: ReadonlyArray<{ runIndex: number; cumulativeGen: number }>,
  plotWidth: number,
  longestLabelChars: number,
  xScale: (cumulativeGen: number) => number,
): Set<number> {
  const selected = selectBoundaryIndices(
    boundaries.length,
    plotWidth,
    longestLabelChars,
  );
  if (boundaries.length <= MAX_BOUNDARY_LABELS) return new Set(selected);

  const labels = selected.map((i) => ({
    x: xScale(boundaries[i].cumulativeGen),
    width: `run ${boundaries[i].runIndex}`.length * ESTIMATED_CHAR_WIDTH_PX,
  }));
  const keepLocal = dropCollidingLabels(labels);
  return new Set(keepLocal.map((k) => selected[k]));
}

export function dropCollidingLabels(
  labels: ReadonlyArray<{ x: number; width: number }>,
): number[] {
  const n = labels.length;
  if (n <= 2) return rangeIndices(n);

  const half = (i: number) => labels[i].width / 2;
  const left = (i: number) => labels[i].x - half(i);
  const right = (i: number) => labels[i].x + half(i);

  // Keep the first anchor, then greedily keep each middle label whose
  // left edge clears the previously-kept label's right edge.
  const keep = [0];
  for (let i = 1; i < n - 1; i++) {
    if (left(i) >= right(keep[keep.length - 1])) keep.push(i);
  }

  // Make room for the last anchor: drop trailing middle labels that
  // would collide with it (never drop the first anchor).
  const lastIdx = n - 1;
  while (keep.length > 1 && left(lastIdx) < right(keep[keep.length - 1])) {
    keep.pop();
  }
  keep.push(lastIdx);
  return keep;
}
