/**
 * Multi-run timeline SVG renderer — hold-out score vs cumulative wall-clock.
 *
 * Plots how long the recorded evolution took to reach each milestone,
 * using {@link MultiRunMilestone.cumulativeWallClockMs} on the X axis
 * and {@link MultiRunMilestone.holdoutScore} (or `1 − error`) on Y.
 */

import type { MultiRunMilestone } from "./multi_run_state.ts";
import {
  cumulativeWallClockMsForMilestone,
  enrichMilestonesWithCumulativeWallClock,
  holdoutScoreForMilestone,
} from "./multi_run_state.ts";
import { escapeAttr, escapeText } from "./chart_axis.ts";
import { makeScale } from "./chart_scale.ts";

/** Options controlling {@link renderMultiRunTimelineChartSVG}. */
export interface RenderMultiRunTimelineChartOptions {
  width?: number;
  height?: number;
  title?: string;
  caption?: boolean;
}

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 400;
const DEFAULT_TITLE = "Multi-run evolution — hold-out score vs wall-clock time";
const SCORE_COLOUR = "#1f77b4";
const MARGIN = { top: 50, right: 40, bottom: 60, left: 70 } as const;

/** Render the timeline chart as an SVG string. */
export function renderMultiRunTimelineChartSVG(
  samples: readonly MultiRunMilestone[],
  options: RenderMultiRunTimelineChartOptions = {},
): string {
  if (samples.length === 0) {
    throw new Error("renderMultiRunTimelineChartSVG requires at least one sample");
  }

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const title = options.title ?? DEFAULT_TITLE;
  const caption = options.caption ?? false;

  const enriched = enrichMilestonesWithCumulativeWallClock(samples);
  const indexed = enriched.map((s, i) => ({ s, i }));
  indexed.sort(
    (a, b) =>
      cumulativeWallClockMsForMilestone(a.s, a.i, enriched) -
      cumulativeWallClockMsForMilestone(b.s, b.i, enriched),
  );

  const plotX = MARGIN.left;
  const plotY = MARGIN.top;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);

  const timesMs = indexed.map(({ s, i }) => cumulativeWallClockMsForMilestone(s, i, enriched));
  const tMin = timesMs[0];
  const tMax = timesMs[timesMs.length - 1];

  const scores = indexed.map(({ s }) => holdoutScoreForMilestone(s));
  const yMin = 0;
  const yMax = Math.max(0.05, Math.max(...scores));

  const xScale = makeScale(tMin, tMax, plotX, plotX + plotW);
  const yScale = makeScale(yMin, yMax, plotY + plotH, plotY);

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `width="${width}" height="${height}" role="img" ` +
      `aria-label="${escapeAttr(title)} chart">`,
    `  <title>${escapeText(title)}</title>`,
    `  <rect width="${width}" height="${height}" fill="#fafafa"/>`,
    `  <text x="${width / 2}" y="24" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="16" font-weight="bold" fill="#222">` +
      escapeText(title) + `</text>`,
    `  <rect x="${plotX}" y="${plotY}" width="${plotW}" height="${plotH}" ` +
      `fill="#ffffff" stroke="#333333" stroke-width="1"/>`,
  );

  lines.push(renderTimeXAxis(tMin, tMax, xScale, plotY + plotH));
  lines.push(renderScoreYAxis(yMin, yMax, yScale, plotX));

  let best = -Infinity;
  const points: { x: number; yBest: number; yRaw: number }[] = [];
  for (let j = 0; j < indexed.length; j++) {
    const { s, i } = indexed[j];
    const t = cumulativeWallClockMsForMilestone(s, i, enriched);
    const raw = holdoutScoreForMilestone(s);
    best = Math.max(best, raw);
    points.push({ x: xScale(t), yBest: yScale(best), yRaw: yScale(raw) });
  }

  if (points.length >= 2) {
    const d = points.map((p, idx) =>
      `${idx === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.yBest.toFixed(2)}`
    ).join(" ");
    lines.push(`  <path d="${d}" fill="none" stroke="${SCORE_COLOUR}" stroke-width="2"/>`);
  }
  for (const p of points) {
    lines.push(
      `  <circle cx="${p.x.toFixed(2)}" cy="${p.yRaw.toFixed(2)}" r="3" ` +
        `fill="#ffffff" stroke="${SCORE_COLOUR}" stroke-width="1.5"/>`,
    );
  }

  if (caption) {
    const totalHours = (timesMs[timesMs.length - 1] / 3_600_000).toFixed(2);
    const finalScore = (scores[scores.length - 1] * 100).toFixed(2);
    lines.push(
      `  <text x="${width / 2}" y="${height - 8}" text-anchor="middle" ` +
        `font-family="sans-serif" font-size="11" fill="#444">` +
        escapeText(
          `Total wall-clock: ${totalHours} h · Final hold-out score: ${finalScore}% · ` +
            `${indexed.length} recorded phase(s)`,
        ) +
        `</text>`,
    );
  }

  lines.push(`</svg>`, "");
  return lines.join("\n");
}

function renderTimeXAxis(
  tMin: number,
  tMax: number,
  xScale: (v: number) => number,
  y: number,
): string {
  const ticks = 5;
  const lines: string[] = [];
  lines.push(
    `  <text x="${xScale((tMin + tMax) / 2)}" y="${y + 36}" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="12" fill="#333">Wall-clock time (hours)</text>`,
  );
  for (let i = 0; i <= ticks; i++) {
    const t = tMin + ((tMax - tMin) * i) / ticks;
    const x = xScale(t);
    const label = (t / 3_600_000).toFixed(1);
    lines.push(
      `  <line x1="${x.toFixed(2)}" y1="${y}" x2="${x.toFixed(2)}" y2="${y + 4}" stroke="#333"/>`,
      `  <text x="${x.toFixed(2)}" y="${y + 16}" text-anchor="middle" ` +
        `font-family="sans-serif" font-size="10" fill="#333">${label}</text>`,
    );
  }
  return lines.join("\n");
}

function renderScoreYAxis(
  yMin: number,
  yMax: number,
  yScale: (v: number) => number,
  x: number,
): string {
  const ticks = 5;
  const lines: string[] = [];
  const midY = (yScale(yMin) + yScale(yMax)) / 2;
  lines.push(
    `  <text x="16" y="${midY}" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="12" fill="#333" ` +
      `transform="rotate(-90 16 ${midY})">Hold-out score</text>`,
  );
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + ((yMax - yMin) * i) / ticks;
    const y = yScale(v);
    lines.push(
      `  <line x1="${x - 4}" y1="${y.toFixed(2)}" x2="${x}" y2="${y.toFixed(2)}" stroke="#333"/>`,
      `  <text x="${x - 8}" y="${(y + 4).toFixed(2)}" text-anchor="end" ` +
        `font-family="sans-serif" font-size="10" fill="#333">${(v * 100).toFixed(0)}%</text>`,
    );
  }
  return lines.join("\n");
}
