/**
 * Side-by-side SVG renderer for the tsp_two_opt example.
 *
 * Draws two panels: the nearest-neighbour seed tour on the left, the
 * post-evolution improved tour on the right. Each panel labels its own
 * tour length; an "optimum" badge sits at the top of the canvas as a
 * reference line. A bottom playhead sweeps from `0` to `1` across the
 * full proposal budget so the SVG visually communicates the swap-by-swap
 * progression even though both panels show static end-state polylines.
 *
 * Output is deterministic given the inputs — no clocks, no PRNG, no
 * non-finite coordinates — so the byte-for-byte SVG can be regression
 * tested.
 */
import type { TspCity } from "../common/tsp_instances.ts";

/** Pixel dimensions of one panel (city plot area only — not the frame). */
const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 320;
/** Horizontal padding inside each panel between the frame and the city plot. */
const PANEL_PAD = 24;
/** Vertical space above the panels reserved for the title row. */
const TITLE_HEIGHT = 36;
/** Vertical space below the panels reserved for the playhead. */
const PLAYHEAD_HEIGHT = 28;
/** Gap between the two panels. */
const PANEL_GAP = 24;

/** Animation duration for one playhead sweep. */
export const ANIMATION_DURATION_SECONDS = 8;

/** Colour for the nearest-neighbour seed tour polyline. */
const SEED_COLOUR = "#888888";
/** Colour for the improved (post-evolution) tour polyline. */
const IMPROVED_COLOUR = "#1f7a1f";
/** Colour for the city dots. */
const CITY_COLOUR = "#1a2230";
/** Colour for the playhead bar fill. */
const PLAYHEAD_COLOUR = "#ff7f50";

/** Input describing one panel. */
export interface PanelTour {
  /** Display title for this panel (e.g. "Nearest-neighbour seed"). */
  readonly title: string;
  /** Tour as an ordered permutation of city indices. */
  readonly tour: ReadonlyArray<number>;
  /** Tour length to print under the title. */
  readonly length: number;
  /** Colour for the polyline. Defaults to {@link SEED_COLOUR} or {@link IMPROVED_COLOUR}. */
  readonly colour?: string;
}

/** Options for {@link renderSideBySideTours}. */
export interface RenderOptions {
  /** Cities in their canonical index order. */
  readonly cities: ReadonlyArray<TspCity>;
  /** Left-panel description (typically the nearest-neighbour seed). */
  readonly left: PanelTour;
  /** Right-panel description (typically the improved tour). */
  readonly right: PanelTour;
  /** Published optimum length, displayed as a reference badge. */
  readonly optimum: number;
  /** Instance name used in the SVG header. */
  readonly instanceName: string;
  /** Number of swap-budget steps for the playhead (purely cosmetic). */
  readonly proposalBudget: number;
}

/**
 * Render the side-by-side SVG. The returned string is deterministic
 * and always ends with a single trailing newline so file diffs stay
 * tidy.
 */
export function renderSideBySideTours(opts: RenderOptions): string {
  const { cities, left, right, optimum, instanceName, proposalBudget } = opts;
  if (cities.length === 0) {
    throw new Error("renderSideBySideTours requires at least one city");
  }
  const svgWidth = PANEL_PAD * 2 + PANEL_WIDTH * 2 + PANEL_GAP;
  const svgHeight = TITLE_HEIGHT + PANEL_HEIGHT + PLAYHEAD_HEIGHT + 24;

  const [minX, maxX, minY, maxY] = bounds(cities);
  const rangeX = Math.max(1e-9, maxX - minX);
  const rangeY = Math.max(1e-9, maxY - minY);

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" ` +
      `width="${svgWidth}" height="${svgHeight}" role="img" ` +
      `aria-label="TSP 2-opt side-by-side comparison for ${instanceName}">`,
  );
  lines.push(
    `  <title>TSP 2-opt — ${instanceName} (seed vs improved tour)</title>`,
  );
  lines.push(
    `  <desc>Side-by-side static comparison of the nearest-neighbour seed tour ` +
      `(length ${left.length.toFixed(2)}) and the post-evolution improved tour ` +
      `(length ${right.length.toFixed(2)}). Published optimum: ${optimum}.</desc>`,
  );
  lines.push(
    `  <rect width="${svgWidth}" height="${svgHeight}" fill="#fafafa"/>`,
  );

  // Header row: instance + optimum badge.
  lines.push(
    `  <text x="12" y="22" font-family="monospace" font-size="14" fill="#1a2230">` +
      `🧭 tsp_two_opt · ${instanceName} · optimum ${optimum}</text>`,
  );

  // Left panel.
  drawPanel(
    lines,
    PANEL_PAD,
    TITLE_HEIGHT,
    cities,
    left,
    SEED_COLOUR,
    minX,
    minY,
    rangeX,
    rangeY,
    optimum,
  );

  // Right panel.
  drawPanel(
    lines,
    PANEL_PAD + PANEL_WIDTH + PANEL_GAP,
    TITLE_HEIGHT,
    cities,
    right,
    IMPROVED_COLOUR,
    minX,
    minY,
    rangeX,
    rangeY,
    optimum,
  );

  // Playhead — sweeps left → right over the proposal budget. Purely
  // cosmetic; the budget is encoded in the aria label below the bar.
  const playheadY = TITLE_HEIGHT + PANEL_HEIGHT + 12;
  const playheadLeft = PANEL_PAD;
  const playheadWidth = svgWidth - PANEL_PAD * 2;
  lines.push(
    `  <rect x="${playheadLeft}" y="${playheadY}" ` +
      `width="${playheadWidth}" height="6" fill="#dddddd" rx="3"/>`,
  );
  lines.push(
    `  <rect class="playhead" x="${playheadLeft}" y="${playheadY}" ` +
      `width="0" height="6" fill="${PLAYHEAD_COLOUR}" rx="3">`,
  );
  lines.push(
    `    <animate attributeName="width" values="0;${playheadWidth}" ` +
      `dur="${ANIMATION_DURATION_SECONDS}s" repeatCount="indefinite" fill="freeze"/>`,
  );
  lines.push(`  </rect>`);
  lines.push(
    `  <text x="${playheadLeft}" y="${playheadY + 22}" ` +
      `font-family="monospace" font-size="11" fill="#555555">` +
      `Proposal budget: ${proposalBudget}</text>`,
  );

  lines.push(`</svg>`);
  lines.push("");
  return lines.join("\n");
}

/** Render one panel into the line buffer. */
function drawPanel(
  out: string[],
  offsetX: number,
  offsetY: number,
  cities: ReadonlyArray<TspCity>,
  panel: PanelTour,
  defaultColour: string,
  minX: number,
  minY: number,
  rangeX: number,
  rangeY: number,
  optimum: number,
): void {
  const colour = panel.colour ?? defaultColour;
  // Frame.
  out.push(
    `  <rect x="${offsetX}" y="${offsetY}" width="${PANEL_WIDTH}" height="${PANEL_HEIGHT}" ` +
      `fill="#ffffff" stroke="#cccccc" stroke-width="1"/>`,
  );
  // Title.
  out.push(
    `  <text x="${offsetX + 8}" y="${offsetY - 6}" font-family="monospace" font-size="12" ` +
      `fill="#1a2230">${panel.title} — length ${panel.length.toFixed(2)}` +
      ` (×${ratio(panel.length, optimum)} optimum)</text>`,
  );

  // Polyline through the tour (closed loop).
  const pts: string[] = [];
  for (const idx of panel.tour) {
    const c = cities[idx];
    const x = projectX(c.x, minX, rangeX, offsetX);
    const y = projectY(c.y, minY, rangeY, offsetY);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  // Close the loop explicitly so the polyline traces every edge.
  if (panel.tour.length > 0) {
    const first = cities[panel.tour[0]];
    pts.push(
      `${projectX(first.x, minX, rangeX, offsetX).toFixed(1)},${
        projectY(first.y, minY, rangeY, offsetY).toFixed(1)
      }`,
    );
  }
  out.push(
    `  <polyline points="${pts.join(" ")}" fill="none" stroke="${colour}" ` +
      `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  );

  // City dots on top.
  for (const c of cities) {
    const x = projectX(c.x, minX, rangeX, offsetX);
    const y = projectY(c.y, minY, rangeY, offsetY);
    out.push(
      `  <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="${CITY_COLOUR}"/>`,
    );
  }
}

/** Project a TSP x-coordinate into panel-relative pixel space. */
function projectX(x: number, minX: number, rangeX: number, offsetX: number): number {
  const usable = PANEL_WIDTH - PANEL_PAD * 2;
  return offsetX + PANEL_PAD + ((x - minX) / rangeX) * usable;
}

/** Project a TSP y-coordinate into panel-relative pixel space (flipped). */
function projectY(y: number, minY: number, rangeY: number, offsetY: number): number {
  const usable = PANEL_HEIGHT - PANEL_PAD * 2;
  // Flip so increasing TSP y points "up" on screen.
  return offsetY + PANEL_HEIGHT - PANEL_PAD - ((y - minY) / rangeY) * usable;
}

/** Bounding-box helper. */
function bounds(cities: ReadonlyArray<TspCity>): [number, number, number, number] {
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
  return [minX, maxX, minY, maxY];
}

/** Format `length / optimum` to two decimal places, or `"∞"` if optimum is 0. */
function ratio(length: number, optimum: number): string {
  if (optimum <= 0) return "∞";
  return (length / optimum).toFixed(2);
}
