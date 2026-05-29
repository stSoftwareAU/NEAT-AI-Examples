/**
 * Unit tests for the shared run-boundary thinning policy.
 *
 * These are "what" tests — they verify the indices returned by
 * `selectBoundaryIndices` for a range of boundary counts, without
 * inspecting how the helper computes them.
 */

import { assert, assertEquals } from "@std/assert";

import {
  ESTIMATED_CHAR_WIDTH_PX,
  MAX_BOUNDARY_LABELS,
  PLOT_WIDTH_USABLE_FRACTION,
  selectBoundaryIndices,
} from "./multi_run_boundary_thinning.ts";

const DEFAULT_PLOT_W = 690; // matches 800 px chart minus 70 + 40 margins.
const DEFAULT_LONGEST = "run 115".length;

Deno.test("selectBoundaryIndices: zero boundaries returns empty", () => {
  assertEquals(selectBoundaryIndices(0, DEFAULT_PLOT_W, DEFAULT_LONGEST), []);
});

Deno.test("selectBoundaryIndices: single boundary returns [0]", () => {
  assertEquals(selectBoundaryIndices(1, DEFAULT_PLOT_W, DEFAULT_LONGEST), [0]);
});

Deno.test("selectBoundaryIndices: ≤10 boundaries selects every index (no thinning)", () => {
  for (let n = 1; n <= MAX_BOUNDARY_LABELS; n++) {
    const indices = selectBoundaryIndices(n, DEFAULT_PLOT_W, DEFAULT_LONGEST);
    assertEquals(indices.length, n, `n=${n}: expected ${n} indices`);
    assertEquals(indices[0], 0);
    assertEquals(indices[n - 1], n - 1);
  }
});

Deno.test(
  "selectBoundaryIndices: 49 boundaries (50 runs) caps at 10 labels and anchors first + last",
  () => {
    const indices = selectBoundaryIndices(49, DEFAULT_PLOT_W, "run 50".length);
    assert(
      indices.length <= MAX_BOUNDARY_LABELS,
      `expected ≤${MAX_BOUNDARY_LABELS} labels, got ${indices.length}`,
    );
    assertEquals(indices[0], 0, "first boundary must be selected");
    assertEquals(
      indices[indices.length - 1],
      48,
      "last boundary must be selected",
    );
  },
);

Deno.test(
  "selectBoundaryIndices: 114 boundaries (115 runs) caps at 10 labels and labels do not overlap at 800 px",
  () => {
    const longest = "run 115".length;
    const indices = selectBoundaryIndices(114, DEFAULT_PLOT_W, longest);
    assert(
      indices.length <= MAX_BOUNDARY_LABELS,
      `expected ≤${MAX_BOUNDARY_LABELS} labels, got ${indices.length}`,
    );
    assertEquals(indices[0], 0);
    assertEquals(indices[indices.length - 1], 113);

    // Verify the selected labels comfortably fit the usable width.
    const labelWidth = longest * ESTIMATED_CHAR_WIDTH_PX;
    const usableWidth = DEFAULT_PLOT_W * PLOT_WIDTH_USABLE_FRACTION;
    assert(
      indices.length * labelWidth <= usableWidth + 1e-6,
      `labels (${indices.length}*${labelWidth}=${indices.length * labelWidth}) ` +
        `exceed usable width ${usableWidth}`,
    );
  },
);

Deno.test("selectBoundaryIndices: deterministic for identical input", () => {
  const a = selectBoundaryIndices(114, DEFAULT_PLOT_W, "run 115".length);
  const b = selectBoundaryIndices(114, DEFAULT_PLOT_W, "run 115".length);
  assertEquals(a, b);
});

Deno.test("selectBoundaryIndices: large counts produce evenly-spaced indices", () => {
  const indices = selectBoundaryIndices(100, DEFAULT_PLOT_W, "run 100".length);
  // Confirm strictly increasing.
  for (let i = 1; i < indices.length; i++) {
    assert(
      indices[i] > indices[i - 1],
      `indices must be strictly increasing: ${indices.join(",")}`,
    );
  }
  // Evenly spaced — every gap is within 1 of the average gap.
  const avgGap = (indices[indices.length - 1] - indices[0]) /
    (indices.length - 1);
  for (let i = 1; i < indices.length; i++) {
    const gap = indices[i] - indices[i - 1];
    assert(
      Math.abs(gap - avgGap) <= 1,
      `gap ${gap} differs from average ${avgGap} by more than 1`,
    );
  }
});

Deno.test(
  "selectBoundaryIndices: narrow plot width still anchors last boundary",
  () => {
    // 30 px plot with a 6-char label → labelWidth ≈ 39, usable ≈ 27.
    // Only one label fits, so the helper should return just the last.
    const indices = selectBoundaryIndices(50, 30, "run 50".length);
    assert(indices.length >= 1);
    assertEquals(indices[indices.length - 1], 49);
  },
);

Deno.test(
  "selectBoundaryIndices: longer labels shrink the selected count at fixed width",
  () => {
    const wide = selectBoundaryIndices(200, DEFAULT_PLOT_W, "run 9".length);
    const narrow = selectBoundaryIndices(200, DEFAULT_PLOT_W, "run 9999".length);
    assert(
      wide.length >= narrow.length,
      `shorter labels should fit at least as many: wide=${wide.length} narrow=${narrow.length}`,
    );
  },
);
