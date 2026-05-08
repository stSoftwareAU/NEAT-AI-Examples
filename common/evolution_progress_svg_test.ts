/**
 * Unit tests for the multi-panel evolution-progress SVG renderer.
 *
 * "What" tests only — they verify observable output of
 * `renderEvolutionProgressSvg` (panel groups, generation labels, score
 * progression line, deterministic byte-identical output) without
 * inspecting how the renderer builds its strings.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";

import {
  type EvolutionProgressSnapshot,
  renderEvolutionProgressSvg,
} from "./evolution_progress_svg.ts";

function makeSnapshot(
  generation: number,
  score: number,
): EvolutionProgressSnapshot {
  return {
    generation,
    score,
    creature: {
      neurons: [
        { type: "input", uuid: `in-${generation}-0`, index: 0 },
        { type: "input", uuid: `in-${generation}-1`, index: 1 },
        { type: "hidden", uuid: `hid-${generation}-0`, index: 2 },
        { type: "output", uuid: `out-${generation}-0`, index: 3 },
      ],
      synapses: [
        { from: 0, to: 2, weight: 0.5 },
        { from: 1, to: 2, weight: -0.3 },
        { from: 2, to: 3, weight: 0.8 },
      ],
      input: 2,
      output: 1,
    },
  };
}

Deno.test("renderEvolutionProgressSvg: happy path emits one panel per snapshot with generation labels", () => {
  const snapshots = [
    makeSnapshot(1, 0.10),
    makeSnapshot(10, 0.55),
    makeSnapshot(10000, 0.97),
  ];
  const svg = renderEvolutionProgressSvg(snapshots);

  // Well-formed root element.
  assertStringIncludes(svg, "<svg");
  assertStringIncludes(svg, "</svg>");

  // Three panel groups.
  const panelMatches = svg.match(/<g class="panel"/g) ?? [];
  assertEquals(panelMatches.length, 3, "expected three panel groups");

  // Each generation label appears verbatim.
  assertStringIncludes(svg, "Gen 1");
  assertStringIncludes(svg, "Gen 10");
  assertStringIncludes(svg, "Gen 10000");

  // Score progression polyline is present.
  assertStringIncludes(svg, 'class="score-progression"');
});

Deno.test("renderEvolutionProgressSvg: empty snapshot list raises a clear error", () => {
  assertThrows(
    () => renderEvolutionProgressSvg([]),
    Error,
    "at least one snapshot",
  );
});

Deno.test("renderEvolutionProgressSvg: score progression polyline endpoints match first and last scores", () => {
  const snapshots = [
    makeSnapshot(1, 0.20),
    makeSnapshot(100, 0.50),
    makeSnapshot(10000, 0.90),
  ];
  const svg = renderEvolutionProgressSvg(snapshots);

  // Pull the polyline points out of the score-progression group.
  const match = svg.match(
    /<polyline class="score-progression"[^>]*points="([^"]+)"/,
  );
  assert(match, "score-progression polyline must be present with points attribute");
  const pts = match[1].trim().split(/\s+/).map((p) => {
    const [x, y] = p.split(",").map(Number);
    return { x, y };
  });
  assertEquals(pts.length, snapshots.length, "one point per snapshot");

  // The Y axis is inverted (higher score → smaller y). The endpoint Y
  // values must reflect the first/last scores: lowest score yields the
  // largest y, highest score yields the smallest y.
  const ys = pts.map((p) => p.y);
  const maxY = Math.max(...ys);
  const minY = Math.min(...ys);

  // First snapshot has the lowest score, so its y should equal maxY.
  assert(
    Math.abs(pts[0].y - maxY) < 0.5,
    `first endpoint y (${pts[0].y}) should match max y (${maxY}) within rounding tolerance`,
  );
  // Last snapshot has the highest score, so its y should equal minY.
  assert(
    Math.abs(pts[pts.length - 1].y - minY) < 0.5,
    `last endpoint y (${
      pts[pts.length - 1].y
    }) should match min y (${minY}) within rounding tolerance`,
  );
});

Deno.test("renderEvolutionProgressSvg: caption overlay summarises the run when supplied", () => {
  const snapshots = [
    makeSnapshot(1, 0.10),
    makeSnapshot(10000, 0.90),
  ];
  const svg = renderEvolutionProgressSvg(snapshots, {
    caption: {
      finalScore: 0.90,
      totalGenerations: 10000,
      wallClockMs: 65_000,
    },
  });

  assertStringIncludes(svg, 'class="caption"');
  assertStringIncludes(svg, "10000");
  // Wall-clock time formatted as either seconds or minutes — ensure some
  // human-readable duration appears.
  assert(
    /\d+(\.\d+)?\s?(s|min|sec)/.test(svg),
    "caption should include a human-readable wall-clock duration",
  );
});

Deno.test("renderEvolutionProgressSvg: SMIL <animate> sequences panel highlights", () => {
  const snapshots = [
    makeSnapshot(1, 0.10),
    makeSnapshot(10, 0.50),
    makeSnapshot(10000, 0.90),
  ];
  const svg = renderEvolutionProgressSvg(snapshots);

  const animateMatches = svg.match(/<animate /g) ?? [];
  // One pulse per panel.
  assert(
    animateMatches.length >= snapshots.length,
    `expected at least ${snapshots.length} <animate> elements, got ${animateMatches.length}`,
  );
});

Deno.test("renderEvolutionProgressSvg: deterministic — identical input yields byte-identical SVG", () => {
  const snapshots = [
    makeSnapshot(1, 0.11),
    makeSnapshot(100, 0.33),
    makeSnapshot(10000, 0.99),
  ];
  const a = renderEvolutionProgressSvg(snapshots, {
    caption: { finalScore: 0.99, totalGenerations: 10000, wallClockMs: 1234 },
  });
  const b = renderEvolutionProgressSvg(snapshots, {
    caption: { finalScore: 0.99, totalGenerations: 10000, wallClockMs: 1234 },
  });
  assertEquals(a, b);
});

Deno.test("renderEvolutionProgressSvg: handles creature JSON with `nodes`/`connections` aliases", () => {
  const snapshots: EvolutionProgressSnapshot[] = [
    {
      generation: 1,
      score: 0.1,
      creature: {
        nodes: [
          { type: "input" },
          { type: "hidden" },
          { type: "output" },
        ],
        connections: [
          { from: 0, to: 1, weight: 0.4 },
          { from: 1, to: 2, weight: 0.6 },
        ],
      },
    },
    {
      generation: 10,
      score: 0.5,
      creature: { nodes: [], connections: [] },
    },
  ];

  const svg = renderEvolutionProgressSvg(snapshots);
  assertStringIncludes(svg, "Gen 1");
  assertStringIncludes(svg, "Gen 10");
  assert(!svg.includes("NaN"), "SVG must not contain NaN");
});
