/**
 * Price-data helpers for the stock-market example.
 *
 * Pure helpers for parsing the SP500 CSV, computing returns, building a
 * sliding-window feature matrix, and producing a chronological train /
 * validation / test split. All functions are deterministic and have no
 * side effects so they can be exercised by unit tests directly.
 */

/** A single dated price observation. */
export interface PricePoint {
  /** ISO-8601 date string, e.g. "1871-01-01". */
  date: string;
  /** Nominal closing price. */
  close: number;
}

/** A single training/validation/test row with a window of features. */
export interface Sample {
  /** Index into the source `prices` array of the day being predicted (`t`). */
  index: number;
  /** Date of day `t` — the day whose direction is being predicted. */
  date: string;
  /** Window of returns from days strictly earlier than `t`. */
  features: number[];
  /** Direction label: 1 if price[t] > price[t-1], else 0. */
  label: 0 | 1;
  /** Realised return on day `t` (relative to day `t-1`). */
  return: number;
  /** Closing price on day `t`. */
  close: number;
}

/** A chronological split of the labelled samples. */
export interface DataSplit {
  train: Sample[];
  validation: Sample[];
  test: Sample[];
}

/**
 * Parse the public S&P 500 CSV format (`Date,SP500,...`) into dated price
 * points. Rows whose `SP500` column is missing or non-positive are
 * skipped — early-period dataset rows occasionally carry a `0.0` value
 * and we cannot compute a return from a zero divisor.
 */
export function parsePriceCSV(text: string): PricePoint[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(",");
  const dateIdx = header.findIndex((h) => h.trim().toLowerCase() === "date");
  const priceIdx = header.findIndex((h) => h.trim().toLowerCase() === "sp500");
  if (dateIdx < 0 || priceIdx < 0) {
    throw new Error(
      `parsePriceCSV: expected 'Date' and 'SP500' columns in header, got: ${lines[0]}`,
    );
  }

  const points: PricePoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const fields = line.split(",");
    const date = fields[dateIdx]?.trim();
    const close = Number.parseFloat(fields[priceIdx] ?? "");
    if (!date || !Number.isFinite(close) || close <= 0) continue;
    points.push({ date, close });
  }
  return points;
}

/**
 * Compute period-over-period simple returns. Result has length
 * `prices.length - 1`; `returns[i]` corresponds to the move from
 * `prices[i]` to `prices[i + 1]`.
 */
export function computeReturns(prices: PricePoint[]): number[] {
  if (prices.length < 2) return [];
  const out: number[] = new Array(prices.length - 1);
  for (let i = 1; i < prices.length; i++) {
    out[i - 1] = (prices[i].close - prices[i - 1].close) / prices[i - 1].close;
  }
  return out;
}

/** Configuration for {@link buildSamples}. */
export interface BuildSamplesOptions {
  /** Window size: how many prior returns are fed to the network. */
  windowSize: number;
}

/**
 * Build sliding-window samples from a price series.
 *
 * For day `t` (0-indexed against `prices`), the feature vector is
 * `[r_{t-windowSize}, ..., r_{t-1}]`, where `r_i` is the return from
 * day `i-1` to day `i`. The label is 1 if the realised return on day
 * `t` is positive, else 0.
 *
 * **No look-ahead**: features for `t` only use prices on days `< t`.
 * The unit tests verify this property on a synthetic monotone series.
 */
export function buildSamples(
  prices: PricePoint[],
  opts: BuildSamplesOptions,
): Sample[] {
  if (opts.windowSize < 1) {
    throw new Error(`buildSamples: windowSize must be >= 1, got ${opts.windowSize}`);
  }
  // Need windowSize prior returns plus the prediction day itself.
  // Returns require two prices each, so we need windowSize + 2 prices.
  const minPrices = opts.windowSize + 2;
  if (prices.length < minPrices) {
    throw new Error(
      `buildSamples: need at least ${minPrices} price points for ` +
        `windowSize=${opts.windowSize}, got ${prices.length}`,
    );
  }

  const returns = computeReturns(prices);
  const samples: Sample[] = [];
  // Sample for day t exists when we have windowSize earlier returns
  // (returns indices [t - windowSize - 1 .. t - 2]) and a return for t
  // itself (returns index t - 1). The first valid t is windowSize + 1.
  for (let t = opts.windowSize + 1; t < prices.length; t++) {
    // returns[i] is the move from prices[i] -> prices[i+1].
    // Features for day t use returns for moves ending strictly before t.
    const features = returns.slice(t - opts.windowSize - 1, t - 1);
    const realised = returns[t - 1];
    samples.push({
      index: t,
      date: prices[t].date,
      features,
      label: realised > 0 ? 1 : 0,
      return: realised,
      close: prices[t].close,
    });
  }
  return samples;
}

/** Configuration for {@link splitChronologically}. */
export interface SplitOptions {
  /** Fraction of samples to allocate to training (0–1). */
  trainFraction: number;
  /** Fraction of samples to allocate to validation (0–1). */
  validationFraction: number;
}

/**
 * Split labelled samples into train / validation / test windows in
 * chronological order — never shuffled. Samples are walked
 * front-to-back: the earliest go into `train`, the next slice into
 * `validation`, and the remainder into `test`. This guarantees no
 * future information leaks back to earlier windows.
 */
export function splitChronologically(samples: Sample[], opts: SplitOptions): DataSplit {
  if (opts.trainFraction <= 0 || opts.validationFraction <= 0) {
    throw new Error("splitChronologically: train/validation fractions must be > 0");
  }
  if (opts.trainFraction + opts.validationFraction >= 1) {
    throw new Error(
      "splitChronologically: train + validation fractions must leave a test slice (< 1)",
    );
  }

  const total = samples.length;
  const trainEnd = Math.floor(total * opts.trainFraction);
  const valEnd = trainEnd + Math.floor(total * opts.validationFraction);
  return {
    train: samples.slice(0, trainEnd),
    validation: samples.slice(trainEnd, valEnd),
    test: samples.slice(valEnd),
  };
}
