/**
 * SVG rendering helpers for the stock-market example.
 *
 * Produces a single animated SVG: a price polyline drawn over the test
 * window, four-colour ▲/▼ glyphs marking each prediction-vs-outcome
 * combination, and a SMIL-driven sweeping play-head that walks
 * left-to-right across the chart so viewers can read the controller's
 * decisions chronologically. Static viewers (no SMIL) still see the
 * full chart, so accessibility and screenshot tools degrade gracefully.
 */

/** Width (in SVG user units) of the rendered chart. */
export const CHART_WIDTH = 720;

/** Height of the chart, including space for axis labels and caption. */
export const CHART_HEIGHT = 360;

/** Total animation duration (seconds) for one full sweep. */
export const ANIMATION_DURATION_SECONDS = 8;

/** One of four prediction × outcome categories. */
export type SignalGlyph = "up_hit" | "up_miss" | "down_hit" | "down_miss";

/** Visual configuration for each glyph category. */
const GLYPH_STYLE: Record<SignalGlyph, { colour: string; symbol: "▲" | "▼"; label: string }> = {
  up_hit: { colour: "#2ecc71", symbol: "▲", label: "Up — correct" },
  up_miss: { colour: "#e67e22", symbol: "▲", label: "Up — wrong" },
  down_hit: { colour: "#3498db", symbol: "▼", label: "Down — correct" },
  down_miss: { colour: "#e74c3c", symbol: "▼", label: "Down — wrong" },
};

/** Minimal record shape needed for rendering. */
export interface RenderRecord {
  date: string;
  close: number;
  prediction: 0 | 1;
  outcome: 0 | 1;
  correct: boolean;
}

/** Options for {@link renderChartSVG}. */
export interface RenderChartOptions {
  records: RenderRecord[];
  glyphFor: (record: RenderRecord) => SignalGlyph;
  validationAccuracy: number;
  testAccuracy: number;
  cumulativeStrategyReturn: number;
}

/**
 * Render an animated price chart.
 *
 * - Draws the close-price polyline over the chart area.
 * - Plots a small ▲ or ▼ marker at each record, coloured by category.
 * - A vertical play-head sweeps left-to-right indefinitely via SMIL.
 * - Caption shows directional accuracy and cumulative simulated return.
 *
 * Throws if `records` is empty — there is nothing meaningful to draw.
 */
export function renderChartSVG(opts: RenderChartOptions): string {
  const { records } = opts;
  if (records.length === 0) {
    throw new Error("renderChartSVG: records must not be empty");
  }

  // Margins for axes, captions, and legend.
  const margin = { top: 50, right: 24, bottom: 60, left: 60 };
  const plotW = CHART_WIDTH - margin.left - margin.right;
  const plotH = CHART_HEIGHT - margin.top - margin.bottom;

  const closes = records.map((r) => r.close);
  const minClose = Math.min(...closes);
  const maxClose = Math.max(...closes);
  // Avoid divide-by-zero on a flat series.
  const closeRange = maxClose - minClose || 1;

  const xFor = (i: number): number =>
    records.length === 1 ? margin.left : margin.left + (i / (records.length - 1)) * plotW;
  const yFor = (close: number): number =>
    margin.top + plotH - ((close - minClose) / closeRange) * plotH;

  // Build the price polyline.
  const linePoints = records
    .map((r, i) => `${xFor(i).toFixed(2)},${yFor(r.close).toFixed(2)}`)
    .join(" ");

  // Build per-record marker strings.
  const markers: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const glyph = opts.glyphFor(r);
    const style = GLYPH_STYLE[glyph];
    const x = xFor(i);
    const y = yFor(r.close);
    // Offset glyph slightly so it does not sit directly on the line.
    const dy = style.symbol === "▲" ? -8 : 14;
    markers.push(
      `  <text class="glyph ${glyph}" x="${x.toFixed(2)}" y="${(y + dy).toFixed(2)}" ` +
        `text-anchor="middle" font-family="sans-serif" font-size="11" ` +
        `fill="${style.colour}"><title>${escapeXml(`${r.date}: ${style.label}`)}` +
        `</title>${style.symbol}</text>`,
    );
  }

  // Y-axis ticks: 4 evenly spaced.
  const yTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const close = minClose + (i / 4) * closeRange;
    const y = yFor(close);
    yTicks.push(
      `  <line x1="${margin.left}" y1="${y.toFixed(2)}" x2="${
        (margin.left + plotW).toFixed(2)
      }" y2="${y.toFixed(2)}" stroke="#eeeeee" stroke-width="1"/>`,
    );
    yTicks.push(
      `  <text x="${margin.left - 6}" y="${
        (y + 3).toFixed(2)
      }" text-anchor="end" font-family="monospace" font-size="10" fill="#666">${
        close.toFixed(0)
      }</text>`,
    );
  }

  // X-axis labels: first, mid, last.
  const xLabelIndices = records.length >= 3
    ? [0, Math.floor(records.length / 2), records.length - 1]
    : [0, records.length - 1];
  const xLabels: string[] = [];
  for (const i of xLabelIndices) {
    const x = xFor(i);
    xLabels.push(
      `  <text x="${x.toFixed(2)}" y="${
        (margin.top + plotH + 18).toFixed(2)
      }" text-anchor="middle" font-family="monospace" font-size="10" fill="#666">${
        escapeXml(records[i].date)
      }</text>`,
    );
  }

  // Animated sweeping play-head.
  const sweepX0 = xFor(0);
  const sweepX1 = xFor(records.length - 1);
  const sweep = [
    `  <line class="playhead" x1="${sweepX0.toFixed(2)}" y1="${margin.top}" ` +
    `x2="${sweepX0.toFixed(2)}" y2="${
      (margin.top + plotH).toFixed(2)
    }" stroke="#9b59b6" stroke-width="2" stroke-dasharray="4 3">`,
    `    <animate attributeName="x1" values="${sweepX0.toFixed(2)};${
      sweepX1.toFixed(2)
    }" dur="${ANIMATION_DURATION_SECONDS}s" repeatCount="indefinite" fill="freeze"/>`,
    `    <animate attributeName="x2" values="${sweepX0.toFixed(2)};${
      sweepX1.toFixed(2)
    }" dur="${ANIMATION_DURATION_SECONDS}s" repeatCount="indefinite" fill="freeze"/>`,
    `  </line>`,
  ].join("\n");

  const captionY = margin.top + plotH + 38;
  const caption =
    `Validation accuracy: ${(opts.validationAccuracy * 100).toFixed(2)}%  ·  Test accuracy: ${
      (opts.testAccuracy * 100).toFixed(2)
    }%  ·  ` +
    `Cumulative strategy return: ${(opts.cumulativeStrategyReturn * 100).toFixed(2)}%`;

  const legendY = 26;
  const legendItems = (Object.keys(GLYPH_STYLE) as SignalGlyph[]).map((key, i) => {
    const style = GLYPH_STYLE[key];
    const x = margin.left + i * 150;
    return [
      `  <text x="${x}" y="${legendY}" font-family="sans-serif" font-size="12" ` +
      `fill="${style.colour}">${style.symbol}</text>`,
      `  <text x="${x + 14}" y="${legendY}" font-family="sans-serif" font-size="11" ` +
      `fill="#444">${escapeXml(style.label)}</text>`,
    ].join("\n");
  }).join("\n");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" ` +
    `width="${CHART_WIDTH}" height="${CHART_HEIGHT}" role="img" ` +
    `aria-label="Stock market direction predictions over the test window, animated">`,
    `  <title>Stock-Market Champion — Test Window (animated)</title>`,
    `  <desc>Animated SVG: the close-price polyline is drawn statically over the test ` +
    `window; four-colour ▲/▼ markers encode each prediction-vs-outcome category, and ` +
    `a vertical play-head sweeps left-to-right every ${ANIMATION_DURATION_SECONDS} seconds.</desc>`,
    `  <rect width="${CHART_WIDTH}" height="${CHART_HEIGHT}" fill="#fafafa"/>`,
    `  <rect x="0" y="0" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" fill="none" ` +
    `stroke="#cccccc"/>`,
    legendItems,
    yTicks.join("\n"),
    `  <polyline class="price" points="${linePoints}" fill="none" stroke="#34495e" ` +
    `stroke-width="1.5"/>`,
    markers.join("\n"),
    sweep,
    xLabels.join("\n"),
    `  <text x="${CHART_WIDTH / 2}" y="${captionY}" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="12" fill="#222">${escapeXml(caption)}</text>`,
    `  <text x="${CHART_WIDTH - 12}" y="${
      CHART_HEIGHT - 6
    }" text-anchor="end" font-family="sans-serif" font-size="9" fill="#888">` +
    `Teaching example — not investment advice</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

/** Minimal XML escaping for text nodes and attribute values. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
