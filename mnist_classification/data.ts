/**
 * Dataset helpers for the MNIST classification example.
 *
 * The example consumes the canonical MNIST handwritten-digit dataset.
 * The IDX files are downloaded from the Common Visual Data Foundation
 * (CVDF) Google-Cloud mirror — the standard mirror recommended by the
 * MNIST community now that Yann LeCun's original site has been retired.
 * Each file is pinned by SHA-256 in `mnist_classification.ts` so the
 * pipeline is byte-deterministic.
 *
 * Each `DigitSample` carries the raw 28×28 pixels both as a normalised
 * `[0, 1]` Float32-friendly feature vector (the network's input — 784
 * features in row-major order) and as the original 0..255 byte array
 * (rendered into the SVG grid).
 */

/** Native side length of an MNIST image. */
export const IMAGE_SIZE = 28;

/** Total number of features fed to the network (`28 * 28`). */
export const FEATURE_COUNT = IMAGE_SIZE * IMAGE_SIZE;

/** Number of digit classes (0..9). */
export const CLASS_COUNT = 10;

/** A single labelled MNIST observation. */
export interface DigitSample {
  /** Index of the sample in the source IDX file. */
  index: number;
  /** Ground-truth class label (0..9). */
  label: number;
  /**
   * Raw 28×28 feature vector of length {@link FEATURE_COUNT} in
   * row-major order, with each value in `[0, 1]` (the source byte
   * normalised by 255).
   */
  features: number[];
  /**
   * Raw 28×28 grey pixels (0..255) in row-major order. Carried so the
   * SVG renderer can show each digit at full resolution alongside the
   * normalised feature vector consumed by the network.
   */
  pixels: number[];
}

/** Parsed images from an IDX-3 file. */
export interface IdxImages {
  count: number;
  rows: number;
  cols: number;
  /** `count * rows * cols` pixels in row-major, sample-major order. */
  data: Uint8Array;
}

/** Parsed labels from an IDX-1 file. */
export interface IdxLabels {
  count: number;
  /** `count` bytes; each entry is a class index in `0..9`. */
  data: Uint8Array;
}

/**
 * Parse a decompressed IDX-3 image file. The official format begins
 * with the magic number `0x00000803`, followed by big-endian 32-bit
 * count / rows / cols and the raw pixel bytes.
 */
export function parseIdxImages(buf: Uint8Array): IdxImages {
  if (buf.length < 16) {
    throw new Error(`parseIdxImages: buffer too small for IDX header (got ${buf.length} bytes)`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.getUint32(0);
  if (magic !== 0x00000803) {
    throw new Error(
      `parseIdxImages: bad magic 0x${magic.toString(16).padStart(8, "0")} ` +
        "(expected 0x00000803 for IDX-3 image data)",
    );
  }
  const count = view.getUint32(4);
  const rows = view.getUint32(8);
  const cols = view.getUint32(12);
  const expected = 16 + count * rows * cols;
  if (buf.length < expected) {
    throw new Error(
      `parseIdxImages: truncated (need ${expected} bytes, got ${buf.length})`,
    );
  }
  return { count, rows, cols, data: buf.subarray(16, expected) };
}

/**
 * Parse a decompressed IDX-1 label file. Magic `0x00000801`, followed
 * by a big-endian 32-bit count and `count` raw label bytes.
 */
export function parseIdxLabels(buf: Uint8Array): IdxLabels {
  if (buf.length < 8) {
    throw new Error(`parseIdxLabels: buffer too small for IDX header (got ${buf.length} bytes)`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.getUint32(0);
  if (magic !== 0x00000801) {
    throw new Error(
      `parseIdxLabels: bad magic 0x${magic.toString(16).padStart(8, "0")} ` +
        "(expected 0x00000801 for IDX-1 label data)",
    );
  }
  const count = view.getUint32(4);
  const expected = 8 + count;
  if (buf.length < expected) {
    throw new Error(
      `parseIdxLabels: truncated (need ${expected} bytes, got ${buf.length})`,
    );
  }
  return { count, data: buf.subarray(8, expected) };
}

/**
 * Combine parsed images and labels into a list of {@link DigitSample}
 * records. Throws when the two files disagree on `count` or when the
 * image dimensions are not the expected 28×28.
 */
export function buildDigitSamples(images: IdxImages, labels: IdxLabels): DigitSample[] {
  if (images.rows !== IMAGE_SIZE || images.cols !== IMAGE_SIZE) {
    throw new Error(
      `buildDigitSamples: expected ${IMAGE_SIZE}×${IMAGE_SIZE} images, ` +
        `got ${images.rows}×${images.cols}`,
    );
  }
  if (images.count !== labels.count) {
    throw new Error(
      `buildDigitSamples: image count ${images.count} != label count ${labels.count}`,
    );
  }
  const samples: DigitSample[] = [];
  const stride = IMAGE_SIZE * IMAGE_SIZE;
  for (let i = 0; i < images.count; i++) {
    const start = i * stride;
    const pixels = images.data.subarray(start, start + stride);
    const features = new Array<number>(stride);
    for (let j = 0; j < stride; j++) features[j] = pixels[j] / 255;
    samples.push({
      index: i,
      label: labels.data[i],
      features,
      pixels: Array.from(pixels),
    });
  }
  return samples;
}

/** Configuration for {@link splitDataset}. */
export interface SplitOptions {
  trainCount: number;
  validationCount: number;
  testCount: number;
}

/** Three contiguous slices of {@link DigitSample}s. */
export interface DigitSplit {
  train: DigitSample[];
  validation: DigitSample[];
  test: DigitSample[];
}

/**
 * Split a sample list into train / validation / test slices in source
 * order. Slicing in source order keeps the split deterministic — there
 * is no shuffling — so two runs over the same IDX bytes produce
 * byte-identical folds.
 *
 * Throws on an empty input list (matches the `mnist_classification`
 * "edge case — empty dataset path raises a clear error" acceptance
 * criterion).
 */
export function splitDataset(samples: DigitSample[], opts: SplitOptions): DigitSplit {
  if (samples.length === 0) {
    throw new Error("splitDataset: samples must not be empty");
  }
  if (opts.trainCount <= 0 || opts.validationCount <= 0 || opts.testCount <= 0) {
    throw new Error(
      `splitDataset: train/validation/test counts must all be positive ` +
        `(got ${opts.trainCount}/${opts.validationCount}/${opts.testCount})`,
    );
  }
  const total = opts.trainCount + opts.validationCount + opts.testCount;
  if (samples.length < total) {
    throw new Error(
      `splitDataset: need at least ${total} samples for the requested split, ` +
        `got ${samples.length}`,
    );
  }
  const trainEnd = opts.trainCount;
  const valEnd = trainEnd + opts.validationCount;
  const testEnd = valEnd + opts.testCount;
  return {
    train: samples.slice(0, trainEnd),
    validation: samples.slice(trainEnd, valEnd),
    test: samples.slice(valEnd, testEnd),
  };
}

/**
 * Decompress a gzipped file into memory using the platform
 * `DecompressionStream` API. Returns the decompressed bytes.
 *
 * Throws when the source file does not exist or contains malformed
 * gzip data.
 */
export async function readGzippedFile(srcPath: string): Promise<Uint8Array> {
  const compressed = await Deno.readFile(srcPath);
  // Wrap the bytes in a Blob so we can use the standard Streams API.
  // deno-lint-ignore no-explicit-any
  const blob = new Blob([compressed as any]);
  const decompressed = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of decompressed as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
