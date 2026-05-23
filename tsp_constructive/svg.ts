/**
 * SVG renderer for the TSP-constructive champion tour.
 *
 * Pure string emission — no DOM, no animation, no external
 * dependencies. The renderer is deterministic: identical inputs always
 * produce the byte-identical SVG payload, so the canonical screenshot
 * checked into `docs/screenshots/` does not drift between runs with the
 * same seed.
 *
 * Output:
 *   - Floor canvas with the published score badge in the top-right corner.
 *   - City coordinates plotted as filled dots.
 *   - Champion tour drawn as a coloured polyline (closed loop).
 *   - Optional optimal/reference tour drawn as a faint dashed polyline
 *     beneath the champion tour for comparison.
 *
 * Mirrors the conventions used by `maze_navigation/svg.ts` and
 * `mountain_car/svg.ts`: pixel layout via small constants at the top of
 * the file, body assembled into a string array, single trailing
 * newline.
 */

import type { TspCity } from "../common/tsp_instances.ts";

const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 480;

const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 24;
const MARGIN_LEFT = 24;
const MARGIN_RIGHT = 24;

const BACKGROUND = "#0d1b2a";
const FLOOR = "#1b263b";
const CITY_DOT = "#e0e1dd";
const CITY_DOT_RADIUS = 4;
const TOUR_COLOUR = "#ffb703";
const TOUR_STROKE_WIDTH = 2.5;
const OPTIMAL_COLOUR = "#9ec5fe";
const OPTIMAL_STROKE_WIDTH = 1.5;
const TEXT_COLOUR = "#f1faee";
const BADGE_FILL = "#1b9aaa";
const BADGE_STROKE = "#0d3b66";

/** A single rendering input — typically the value returned by `runConstructiveEpisode`. */
export interface TourSvgInput {
  /** Human-readable instance name (e.g. "burma14"). */
  readonly instanceName: string;
  /** City coordinates indexed by tour. */
  readonly cities: ReadonlyArray<TspCity>;
  /** Champion tour in visit order. */
  readonly tour: ReadonlyArray<number>;
  /** Total Euclidean length of the champion tour. */
  readonly tourLength: number;
  /** Published optimum (used in the score badge). */
  readonly optimum: number;
  /** Optional reference tour drawn as a dashed underlay. */
  readonly optimalTour?: ReadonlyArray<number>;
}

interface BoundingBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

function boundingBox(cities: ReadonlyArray<TspCity>): BoundingBox {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of cities) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  return { minX, maxX, minY, maxY };
}

interface Projection {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly originX: number;
  readonly originY: number;
  readonly bbox: BoundingBox;
}

function projection(cities: ReadonlyArray<TspCity>): Projection {
  const bbox = boundingBox(cities);
  const width = CANVAS_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
  const height = CANVAS_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  const sx = (bbox.maxX - bbox.minX) > 0 ? width / (bbox.maxX - bbox.minX) : 1;
  const sy = (bbox.maxY - bbox.minY) > 0 ? height / (bbox.maxY - bbox.minY) : 1;
  const scale = Math.min(sx, sy);
  return { width, height, scale, originX: bbox.minX, originY: bbox.minY, bbox };
}

function projectX(city: TspCity, proj: Projection): number {
  return MARGIN_LEFT + (city.x - proj.originX) * proj.scale;
}

function projectY(city: TspCity, proj: Projection): number {
  // SVG y-axis grows downward; flip so larger TSPLIB y is drawn higher.
  const usable = CANVAS_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  return MARGIN_TOP + usable - (city.y - proj.originY) * proj.scale;
}

function fmt(value: number): string {
  // Two-decimal fixed-point keeps the output stable across platforms
  // (some Node/Deno builds otherwise emit different exponent forms).
  return value.toFixed(2);
}

function polylinePoints(
  tour: ReadonlyArray<number>,
  cities: ReadonlyArray<TspCity>,
  proj: Projection,
): string {
  const parts: string[] = [];
  for (const idx of tour) {
    parts.push(`${fmt(projectX(cities[idx], proj))},${fmt(projectY(cities[idx], proj))}`);
  }
  // Close the loop by repeating the first vertex.
  if (tour.length > 0) {
    const first = tour[0];
    parts.push(`${fmt(projectX(cities[first], proj))},${fmt(projectY(cities[first], proj))}`);
  }
  return parts.join(" ");
}

/**
 * Render the champion tour as a deterministic SVG string.
 */
export function renderTourSVG(input: TourSvgInput): string {
  if (input.cities.length === 0) {
    throw new Error("renderTourSVG: cities must be non-empty");
  }
  if (input.tour.length !== input.cities.length) {
    throw new Error(
      `renderTourSVG: tour length ${input.tour.length} != cities length ${input.cities.length}`,
    );
  }
  const proj = projection(input.cities);
  const lines: string[] = [];

  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}" ` +
      `width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" role="img" ` +
      `aria-label="TSP-constructive champion tour for ${input.instanceName}">`,
  );
  lines.push(
    `  <title>TSP-constructive — ${input.instanceName} champion tour</title>`,
  );
  lines.push(
    `  <desc>Deterministic SVG of the champion tour. Cities are dots; the champion ` +
      `tour is the orange polyline; the optional dashed underlay (when present) is ` +
      `the reference tour.</desc>`,
  );
  lines.push(`  <rect width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" fill="${BACKGROUND}"/>`);
  lines.push(
    `  <rect x="${MARGIN_LEFT}" y="${MARGIN_TOP}" ` +
      `width="${CANVAS_WIDTH - MARGIN_LEFT - MARGIN_RIGHT}" ` +
      `height="${CANVAS_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM}" fill="${FLOOR}"/>`,
  );

  // Optimal-tour underlay (drawn first so the champion sits on top).
  if (input.optimalTour && input.optimalTour.length === input.cities.length) {
    lines.push(
      `  <polyline class="optimal" points="${
        polylinePoints(input.optimalTour, input.cities, proj)
      }" fill="none" stroke="${OPTIMAL_COLOUR}" stroke-width="${OPTIMAL_STROKE_WIDTH}" ` +
        `stroke-dasharray="4 4" opacity="0.7"/>`,
    );
  }

  // Champion tour polyline.
  lines.push(
    `  <polyline class="champion" points="${polylinePoints(input.tour, input.cities, proj)}" ` +
      `fill="none" stroke="${TOUR_COLOUR}" stroke-width="${TOUR_STROKE_WIDTH}" ` +
      `stroke-linejoin="round" stroke-linecap="round"/>`,
  );

  // City dots.
  lines.push(`  <g class="cities">`);
  for (let i = 0; i < input.cities.length; i++) {
    const c = input.cities[i];
    const cx = fmt(projectX(c, proj));
    const cy = fmt(projectY(c, proj));
    lines.push(
      `    <circle cx="${cx}" cy="${cy}" r="${CITY_DOT_RADIUS}" fill="${CITY_DOT}"/>`,
    );
  }
  lines.push(`  </g>`);

  // Title and score badge.
  lines.push(
    `  <text x="${MARGIN_LEFT}" y="28" font-family="monospace" font-size="14" ` +
      `fill="${TEXT_COLOUR}">📍 TSP-constructive · ${input.instanceName}</text>`,
  );
  lines.push(
    `  <text x="${MARGIN_LEFT}" y="46" font-family="monospace" font-size="11" ` +
      `fill="${TEXT_COLOUR}" opacity="0.85">` +
      `length=${fmt(input.tourLength)} · optimum=${fmt(input.optimum)} · ` +
      `score=${fmt(Math.min(1, input.optimum / Math.max(input.tourLength, 1e-9)))}</text>`,
  );
  const badgeWidth = 70;
  const badgeX = CANVAS_WIDTH - MARGIN_RIGHT - badgeWidth;
  lines.push(
    `  <rect x="${badgeX}" y="14" width="${badgeWidth}" height="28" rx="6" ` +
      `fill="${BADGE_FILL}" stroke="${BADGE_STROKE}" stroke-width="1"/>`,
  );
  lines.push(
    `  <text x="${badgeX + badgeWidth / 2}" y="33" text-anchor="middle" ` +
      `font-family="monospace" font-size="13" fill="${TEXT_COLOUR}">` +
      `${fmt(Math.min(1, input.optimum / Math.max(input.tourLength, 1e-9)))}</text>`,
  );
  lines.push(`</svg>`);
  lines.push("");
  return lines.join("\n");
}
