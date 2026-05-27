/**
 * Weighted squash randomisation — mirrors GRQ `worker/shared/squash_random.sh`.
 */

/** Squash names with selection weights (higher = more likely). */
export const WEIGHTED_SQUASHES: readonly (readonly [string, number])[] = [
  ["Mish", 37],
  ["ReLU", 36],
  ["Swish", 35],
  ["GELU", 34],
  ["ELU", 33],
  ["SELU", 32],
  ["TANH", 31],
  ["LOGISTIC", 26],
  ["Softplus", 25],
  ["ArcTan", 24],
  ["SOFTSIGN", 23],
  ["HARD_TANH", 22],
  ["BENT_IDENTITY", 21],
  ["SINE", 17],
  ["Cosine", 16],
  ["ABSOLUTE", 15],
  ["Cube", 14],
  ["ISRU", 13],
  ["LogSigmoid", 12],
  ["GAUSSIAN", 11],
] as const;

/** MNIST exploration default squash scan set (subset of the weighted pool). */
export const DEFAULT_SQUASH_CANDIDATES = ["GELU", "Swish", "LeakyReLU", "Mish"] as const;

/**
 * Pick one squash name using the GRQ weighted table.
 * Pass `random` for deterministic tests (`() => 0.5`).
 */
export function randomWeightedSquash(random = Math.random): string {
  const choices: string[] = [];
  for (const [squash, weight] of WEIGHTED_SQUASHES) {
    for (let i = 0; i < weight; i++) {
      choices.push(squash);
    }
  }
  const index = Math.floor(random() * choices.length);
  return choices[Math.min(index, choices.length - 1)]!;
}
