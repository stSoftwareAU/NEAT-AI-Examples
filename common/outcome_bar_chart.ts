/**
 * Per-validation-scenario outcome bar chart renderer.
 *
 * Visualises a champion's outcome across every validation scenario as a
 * single SVG. The layout is the 2x2 split recommended in #200:
 *
 *   - **Left panel** — a four-bar count chart (`landed`, `crashed`,
 *     `out_of_bounds`, `flying`). Reads the headline robustness number
 *     at a glance.
 *   - **Right panel** — a per-scenario strip with one coloured cell per
 *     scenario, in pool order. Reading left-to-right surfaces individual
 *     failures (a single red cell in a sea of green is obvious).
 *
 * Why both? The four-bar count is hopeless at 200 scenarios for spotting
 * which specific seeds failed, and the 200-cell strip is hopeless for
 * reading the "92% landed" headline. Stacking them in one SVG gives the
 * reader both views without having to flip between charts.
 *
 * Count-panel bar heights are scaled against the **total scenario count**
 * so bar proportions match the headline fractions (linear in landed share),
 * not against the tallest single category alone.
 *
 * Output is byte-deterministic for identical input — no timestamps, no
 * Math.random, no DOM. Pure string emission, matching the convention of
 * {@link ./milestone_chart.ts}.
 */

/** Outcome categories supported by the renderer. */
export type OutcomeCategory = "landed" | "crashed" | "out_of_bounds" | "flying";

/** A single per-scenario outcome record. */
export interface ScenarioOutcome {
  /** Scenario index in pool order. Used purely for tooltip / aria text. */
  scenarioIndex: number;
  /** Final classification of the trial. */
  outcome: OutcomeCategory;
  /** Trial score under the example's scoring function. */
  score: number;
}

/** Options controlling {@link renderOutcomeBarChartSVG}. */
export interface RenderOutcomeBarChartOptions {
  /** Total SVG width in user units. Default 800. */
  width?: number;
  /** Total SVG height in user units. Default 320. */
  height?: number;
  /** Chart title rendered at the top. Default "Validation Outcomes". */
  title?: string;
}

/** Display order for the count panel — the canonical ordering used in JSDoc. */
export const OUTCOME_ORDER: readonly OutcomeCategory[] = [
  "landed",
  "crashed",
  "out_of_bounds",
  "flying",
] as const;

/** Colour swatch per outcome — kept here so the count bars and strip cells agree. */
export const OUTCOME_COLOUR: Readonly<Record<OutcomeCategory, string>> = {
  landed: "#2ca02c",
  crashed: "#d62728",
  out_of_bounds: "#7f7f7f",
  flying: "#1f77b4",
};

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 320;

/** Plot-area inset from the SVG edges, leaving room for axes and legend. */
const MARGIN = { top: 50, right: 20, bottom: 60, left: 60 } as const;

/**
 * Render the per-scenario outcomes as an SVG string with a 2x2 layout
 * (count bars on the left, per-scenario strip on the right).
 *
 * Throws if `outcomes` is empty — callers are expected to skip rendering
 * when no scenarios have been validated.
 */
export function renderOutcomeBarChartSVG(
  outcomes: readonly ScenarioOutcome[],
  options: RenderOutcomeBarChartOptions = {},
): string {
  if (outcomes.length === 0) {
    throw new Error("renderOutcomeBarChartSVG requires at least one outcome");
  }

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const title = options.title ?? "Validation Outcomes";

  const plotX = MARGIN.left;
  const plotY = MARGIN.top;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);

  // Split the plot area: the left panel is a small four-bar count chart;
  // the right panel hosts the per-scenario strip. The 35/65 split keeps
  // the headline counts readable while giving the strip plenty of room
  // for 200 cells.
  const leftW = Math.max(120, Math.floor(plotW * 0.35));
  const stripX = plotX + leftW + 24;
  const stripW = Math.max(60, plotX + plotW - stripX);

  const counts = countOutcomes(outcomes);
  const totalScenarios = outcomes.length;

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `width="${width}" height="${height}" role="img" ` +
      `aria-label="${escapeAttr(title)} bar chart">`,
    `  <title>${escapeText(title)}</title>`,
    `  <rect width="${width}" height="${height}" fill="#fafafa"/>`,
    `  <text x="${width / 2}" y="24" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
      escapeText(title) +
      `</text>`,
  );

  lines.push(renderCountPanel(counts, totalScenarios, plotX, plotY, leftW, plotH));
  lines.push(renderScenarioStrip(outcomes, stripX, plotY, stripW, plotH));
  lines.push(renderLegend(plotX, plotY + plotH + 24, width - MARGIN.left - MARGIN.right));

  lines.push(`</svg>`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Counts panel (left-hand four-bar chart)
// ---------------------------------------------------------------------------

interface OutcomeCounts {
  landed: number;
  crashed: number;
  out_of_bounds: number;
  flying: number;
}

function countOutcomes(outcomes: readonly ScenarioOutcome[]): OutcomeCounts {
  const counts: OutcomeCounts = { landed: 0, crashed: 0, out_of_bounds: 0, flying: 0 };
  for (const o of outcomes) counts[o.outcome] += 1;
  return counts;
}

function renderCountPanel(
  counts: OutcomeCounts,
  total: number,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  // Scale bar height as count / total so a 170/200 landed split reads as
  // ~85% of the panel, not ~100% (which happened when the ceiling was the
  // largest category count alone).
  const scaleMax = Math.max(1, total);

  const out: string[] = [];
  out.push(`  <g class="count-panel" font-family="sans-serif" font-size="11" fill="#333">`);
  out.push(
    `    <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ` +
      `fill="#ffffff" stroke="#333" stroke-width="1"/>`,
  );

  // Bars: equal-width slots across the panel with 20% padding either side.
  const slotCount = OUTCOME_ORDER.length;
  const slotW = w / slotCount;
  const barW = slotW * 0.6;
  for (let i = 0; i < slotCount; i++) {
    const cat = OUTCOME_ORDER[i];
    const count = counts[cat];
    const barH = (count / scaleMax) * h;
    const barX = x + i * slotW + (slotW - barW) / 2;
    const barY = y + h - barH;
    out.push(
      `    <rect class="count-bar count-bar-${cat}" x="${fmt(barX)}" y="${fmt(barY)}" ` +
        `width="${fmt(barW)}" height="${fmt(barH)}" fill="${OUTCOME_COLOUR[cat]}"/>`,
    );
    // Count label above the bar.
    out.push(
      `    <text x="${fmt(barX + barW / 2)}" y="${fmt(barY - 4)}" text-anchor="middle" ` +
        `font-weight="bold">${count}</text>`,
    );
    // Category label below the bar.
    out.push(
      `    <text x="${fmt(barX + barW / 2)}" y="${fmt(y + h + 16)}" text-anchor="middle">` +
        escapeText(cat) +
        `</text>`,
    );
  }

  // Y axis: label on the left edge.
  out.push(
    `    <text x="${fmt(x - 10)}" y="${fmt(y + h / 2)}" text-anchor="middle" ` +
      `dominant-baseline="middle" font-weight="bold" ` +
      `transform="rotate(-90 ${fmt(x - 10)} ${fmt(y + h / 2)})">scenarios (${total})</text>`,
  );

  out.push(`  </g>`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Per-scenario strip (right-hand cell grid)
// ---------------------------------------------------------------------------

function renderScenarioStrip(
  outcomes: readonly ScenarioOutcome[],
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  const n = outcomes.length;
  // Choose a roughly-square grid sized to fill the panel. With 200
  // scenarios this gives ~14×15 cells — easy to scan visually.
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * w) / h)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cellW = w / cols;
  const cellH = h / rows;
  // Inset the cell rectangle slightly so adjacent cells do not bleed
  // into each other once the SVG is rasterised.
  const pad = Math.min(cellW, cellH) * 0.06;

  const out: string[] = [];
  out.push(`  <g class="scenario-strip" font-family="sans-serif" font-size="10" fill="#333">`);
  out.push(
    `    <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ` +
      `fill="#ffffff" stroke="#333" stroke-width="1"/>`,
  );

  for (let i = 0; i < n; i++) {
    const o = outcomes[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = x + col * cellW + pad;
    const cy = y + row * cellH + pad;
    out.push(
      `    <rect class="scenario-cell scenario-cell-${o.outcome}" ` +
        `x="${fmt(cx)}" y="${fmt(cy)}" width="${fmt(cellW - 2 * pad)}" ` +
        `height="${fmt(cellH - 2 * pad)}" fill="${OUTCOME_COLOUR[o.outcome]}">` +
        `<title>scenario ${o.scenarioIndex}: ${o.outcome} (score=${formatScore(o.score)})</title>` +
        `</rect>`,
    );
  }

  // Title above the strip noting the per-scenario layout.
  out.push(
    `    <text x="${fmt(x)}" y="${fmt(y - 8)}" text-anchor="start" ` +
      `font-weight="bold">per-scenario outcome (n=${n})</text>`,
  );

  // Score range axis: min and max scores at the bottom corners so the
  // reader can sanity-check the spread without a full numeric axis.
  let minScore = Infinity;
  let maxScore = -Infinity;
  for (const o of outcomes) {
    if (o.score < minScore) minScore = o.score;
    if (o.score > maxScore) maxScore = o.score;
  }
  out.push(
    `    <text class="score-axis-min" x="${fmt(x)}" y="${fmt(y + h + 16)}" ` +
      `text-anchor="start">min score ${formatScore(minScore)}</text>`,
  );
  out.push(
    `    <text class="score-axis-max" x="${fmt(x + w)}" y="${fmt(y + h + 16)}" ` +
      `text-anchor="end">max score ${formatScore(maxScore)}</text>`,
  );

  out.push(`  </g>`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Legend (shared between count bars and strip cells)
// ---------------------------------------------------------------------------

function renderLegend(x: number, y: number, w: number): string {
  const itemW = w / OUTCOME_ORDER.length;
  const out: string[] = [];
  out.push(`  <g class="legend" font-family="sans-serif" font-size="11" fill="#222">`);
  for (let i = 0; i < OUTCOME_ORDER.length; i++) {
    const cat = OUTCOME_ORDER[i];
    const itemX = x + i * itemW;
    out.push(
      `    <rect class="legend-swatch" x="${fmt(itemX)}" y="${fmt(y)}" width="14" height="12" ` +
        `fill="${OUTCOME_COLOUR[cat]}"/>`,
    );
    out.push(
      `    <text x="${fmt(itemX + 20)}" y="${fmt(y + 10)}">${escapeText(cat)}</text>`,
    );
  }
  out.push(`  </g>`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Number / text formatting
// ---------------------------------------------------------------------------

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 100) / 100).toString();
}

function formatScore(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return (Math.round(v * 1000) / 1000).toString();
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
