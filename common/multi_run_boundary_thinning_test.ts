/**
 * Unit tests for the shared run-boundary thinning policy.
 *
 * These are "what" tests — they verify the indices returned by
 * `selectBoundaryIndices` for a range of boundary counts, without
 * inspecting how the helper computes them.
 */

import { assert, assertEquals } from "@std/assert";

import {
  dropCollidingLabels,
  ESTIMATED_CHAR_WIDTH_PX,
  MAX_BOUNDARY_LABELS,
  PLOT_WIDTH_USABLE_FRACTION,
  selectBoundaryIndices,
  selectVisibleBoundaryIndices,
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

Deno.test("dropCollidingLabels: empty input returns empty", () => {
  assertEquals(dropCollidingLabels([]), []);
});

Deno.test("dropCollidingLabels: single label is always kept", () => {
  assertEquals(dropCollidingLabels([{ x: 100, width: 40 }]), [0]);
});

Deno.test("dropCollidingLabels: two labels keep both even when overlapping", () => {
  // The two anchors (first + last) must always survive.
  assertEquals(dropCollidingLabels([{ x: 100, width: 40 }, { x: 110, width: 40 }]), [0, 1]);
});

Deno.test("dropCollidingLabels: well-spaced labels are all kept", () => {
  const labels = [
    { x: 50, width: 40 },
    { x: 150, width: 40 },
    { x: 250, width: 40 },
    { x: 350, width: 40 },
  ];
  assertEquals(dropCollidingLabels(labels), [0, 1, 2, 3]);
});

Deno.test("dropCollidingLabels: drops overlapping middle labels but keeps first + last", () => {
  // Labels bunched on the right (mimics log-x run clustering): only the
  // first, one survivor, and the last anchor should remain.
  const labels = [
    { x: 50, width: 40 }, // index 0 — first anchor
    { x: 600, width: 40 },
    { x: 615, width: 40 },
    { x: 630, width: 40 },
    { x: 645, width: 40 }, // index 4 — last anchor
  ];
  const kept = dropCollidingLabels(labels);
  assertEquals(kept[0], 0, "first anchor kept");
  assertEquals(kept[kept.length - 1], 4, "last anchor kept");
  // No two kept labels overlap horizontally.
  for (let i = 1; i < kept.length; i++) {
    const prev = labels[kept[i - 1]];
    const curr = labels[kept[i]];
    assert(
      (curr.x - curr.width / 2) >= (prev.x + prev.width / 2),
      `kept labels overlap: ${JSON.stringify(prev)} / ${JSON.stringify(curr)}`,
    );
  }
});

Deno.test("dropCollidingLabels: output is strictly increasing index order", () => {
  const labels = Array.from({ length: 10 }, (_, i) => ({ x: 40 + i * 12, width: 40 }));
  const kept = dropCollidingLabels(labels);
  for (let i = 1; i < kept.length; i++) {
    assert(kept[i] > kept[i - 1], `indices must increase: ${kept.join(",")}`);
  }
  assertEquals(kept[0], 0);
  assertEquals(kept[kept.length - 1], 9);
});

// Linear x-scale spanning the default 690 px plot area.
const linearScale = (lo: number, hi: number) => (v: number) =>
  70 + ((v - lo) / (hi - lo)) * DEFAULT_PLOT_W;

Deno.test(
  "selectVisibleBoundaryIndices: ≤10 boundaries keeps every index (byte-identical path)",
  () => {
    const boundaries = Array.from({ length: 5 }, (_, i) => ({
      runIndex: i + 2,
      cumulativeGen: (i + 1) * 100,
    }));
    const scale = linearScale(0, 600);
    const visible = selectVisibleBoundaryIndices(
      boundaries,
      DEFAULT_PLOT_W,
      "run 6".length,
      scale,
    );
    assertEquals([...visible].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  },
);

Deno.test(
  "selectVisibleBoundaryIndices: clustered log-X boundaries render without overlapping labels",
  () => {
    // 115 runs → 114 boundaries; cumulative generations grow then bunch
    // near the right, mimicking the MNIST log-X failure mode (#514).
    const boundaries = Array.from({ length: 114 }, (_, i) => ({
      runIndex: i + 2,
      // Quadratic spacing pushes later boundaries close together on a
      // linear scale, exaggerating the right-edge crowding.
      cumulativeGen: 30 + i * i,
    }));
    const maxGen = boundaries[boundaries.length - 1].cumulativeGen;
    const scale = linearScale(30, maxGen);
    const longest = "run 115".length;
    const visible = selectVisibleBoundaryIndices(
      boundaries,
      DEFAULT_PLOT_W,
      longest,
      scale,
    );

    const kept = [...visible].sort((a, b) => a - b);
    assert(kept.length <= MAX_BOUNDARY_LABELS, `≤10 labels, got ${kept.length}`);
    assertEquals(kept[0], 0, "first boundary anchored");
    assertEquals(kept[kept.length - 1], 113, "last boundary anchored");

    // No two rendered labels overlap horizontally.
    for (let i = 1; i < kept.length; i++) {
      const prev = boundaries[kept[i - 1]];
      const curr = boundaries[kept[i]];
      const prevRight = scale(prev.cumulativeGen) +
        (`run ${prev.runIndex}`.length * ESTIMATED_CHAR_WIDTH_PX) / 2;
      const currLeft = scale(curr.cumulativeGen) -
        (`run ${curr.runIndex}`.length * ESTIMATED_CHAR_WIDTH_PX) / 2;
      assert(
        currLeft >= prevRight,
        `labels for run ${prev.runIndex} and run ${curr.runIndex} overlap`,
      );
    }
  },
);
