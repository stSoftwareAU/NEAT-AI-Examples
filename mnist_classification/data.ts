/**
 * Dataset helpers for the MNIST classification example.
 *
 * The example consumes the canonical MNIST handwritten-digit dataset.
 * The two test-set IDX files (`t10k-images-idx3-ubyte.gz` and
 * `t10k-labels-idx1-ubyte.gz`) are downloaded from the Common Visual
 * Data Foundation (CVDF) Google-Cloud mirror — the standard mirror
 * recommended by the MNIST community now that Yann LeCun's original
 * site has been retired. Each file is pinned by SHA-256 in
 * `mnist_classification.ts` so the pipeline is byte-deterministic.
 *
 * Although the issue text mentions a "CSV mirror", the IDX format is:
 *
 *   1. Tiny — the test set is ~1.6 MB compressed (vs ~18 MB CSV).
 *   2. The canonical primary source for MNIST.
 *   3. Stably hosted on a CDN that is publicly digest-pinnable.
 *
 * That makes IDX the right choice for keeping the repository small and
 * the CI run fast. The README documents the trade-off.
 *
 * After download we decompress, parse the IDX header, mean-pool each
 * 28×28 image down to 14×14 (so the evolutionary search only has to
 * tune 196 weights per output class), and emit `DigitSample` records
 * carrying both the down-sampled feature vector (network input) and
 * the original 784-pixel array (rendered into the SVG grid).
 */

import { ensureDir } from "@std/fs";
import { dirname } from "@std/path";

/** Native side length of an MNIST image. */
export const IMAGE_SIZE = 28;

/** Down-sampled feature grid side length used by the network. */
export const DOWNSAMPLED_SIZE = 14;

/** Total number of features fed to the network (`14 * 14`). */
export const FEATURE_COUNT = DOWNSAMPLED_SIZE * DOWNSAMPLED_SIZE;

/** Number of digit classes (0..9). */
export const CLASS_COUNT = 10;

/** A single labelled MNIST observation. */
export interface DigitSample {
  /** Index of the sample in the source IDX file. */
  index: number;
  /** Ground-truth class label (0..9). */
  label: number;
  /**
   * Down-sampled feature vector of length {@link FEATURE_COUNT}, with
   * each value in `[0, 1]` (mean-pooled over the 2×2 source block and
   * normalised by 255).
   */
  features: number[];
  /**
   * Raw 28×28 grey pixels (0..255) in row-major order. Carried so the
   * SVG renderer can show each digit at full resolution even though
   * the network only sees the down-sampled feature vector.
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
 * Mean-pool an `srcSize × srcSize` greyscale image down to
 * `dstSize × dstSize`. Each output pixel is the average of a
 * `(srcSize / dstSize) × (srcSize / dstSize)` block of source pixels,
 * normalised by 255 so the result is in `[0, 1]`.
 *
 * Throws when the source is not an integer multiple of the target —
 * that would require interpolation, which is out of scope for the
 * teaching example.
 */
export function downsamplePixels(
  pixels: ArrayLike<number>,
  srcSize: number,
  dstSize: number,
): number[] {
  if (dstSize <= 0 || srcSize <= 0) {
    throw new Error(
      `downsamplePixels: sizes must be positive (got src=${srcSize}, dst=${dstSize})`,
    );
  }
  if (srcSize % dstSize !== 0) {
    throw new Error(
      `downsamplePixels: srcSize ${srcSize} must be an integer multiple of dstSize ${dstSize}`,
    );
  }
  if (pixels.length !== srcSize * srcSize) {
    throw new Error(
      `downsamplePixels: expected ${srcSize * srcSize} pixels, got ${pixels.length}`,
    );
  }
  const block = srcSize / dstSize;
  const blockArea = block * block;
  const out = new Array<number>(dstSize * dstSize).fill(0);
  for (let dy = 0; dy < dstSize; dy++) {
    for (let dx = 0; dx < dstSize; dx++) {
      let sum = 0;
      for (let oy = 0; oy < block; oy++) {
        const sy = dy * block + oy;
        for (let ox = 0; ox < block; ox++) {
          sum += pixels[sy * srcSize + (dx * block + ox)];
        }
      }
      out[dy * dstSize + dx] = sum / (blockArea * 255);
    }
  }
  return out;
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
    samples.push({
      index: i,
      label: labels.data[i],
      features: downsamplePixels(pixels, IMAGE_SIZE, DOWNSAMPLED_SIZE),
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

/**
 * Ensure the parent directory of `path` exists. Used by the runner to
 * make sure intermediate output paths are writable before saving the
 * champion creature or confusion matrix.
 */
export async function ensureParentDir(path: string): Promise<void> {
  await ensureDir(dirname(path));
}
