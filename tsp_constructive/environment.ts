/**
 * TSP-constructive episode runner.
 *
 * Each episode constructs a full tour by repeatedly asking the
 * controller to pick its next city from the `K_NEAREST` unvisited
 * candidates. The tour always starts at city 0 (deterministic) and
 * implicitly closes by adding the return edge to the start city after
 * every city has been visited.
 *
 * Tour length is measured in **TSPLIB GEO (great-circle) distance**
 * (kilometres), because the published optima for `burma14` (3,323) and
 * `ulysses22` (7,013) are GEO distances. Computing the tour length in
 * the same metric makes fitness `optimum / tourLength` naturally land
 * in `(0, 1]` — `1.0` is the published optimum, smaller values are
 * worse tours.
 *
 * The agent observations themselves use Euclidean-space `(dx, dy)`
 * channels (see {@link encodeObservation}); for normalisation purposes
 * the two metrics are interchangeable.
 */

import { boundingBoxDiagonal, type TspCity } from "../common/tsp_instances.ts";

import {
  type Candidate,
  decodeAction,
  encodeObservation,
  K_NEAREST,
  kNearestUnvisited,
} from "./agent.ts";

/** Activate-an-input contract that mirrors `Creature.activate`. */
export type ActivateFn = (input: Float32Array) => Float32Array | ArrayLike<number>;

/**
 * TSPLIB GEO-distance formula (kilometres). The TSPLIB coordinates are
 * latitude/longitude given as `degrees.minutes` packed into the `x`
 * (latitude) and `y` (longitude) fields. The reference C code is
 * reproduced verbatim in the TSPLIB95 user manual; this is a
 * line-for-line port.
 */
function geoDegToRad(packed: number): number {
  const deg = Math.trunc(packed);
  const min = packed - deg;
  return Math.PI * (deg + (5 * min) / 3) / 180;
}

const TSPLIB_EARTH_RADIUS_KM = 6378.388;

export function geoDistance(a: TspCity, b: TspCity): number {
  const lat1 = geoDegToRad(a.x);
  const lat2 = geoDegToRad(b.x);
  const lon1 = geoDegToRad(a.y);
  const lon2 = geoDegToRad(b.y);
  const q1 = Math.cos(lon1 - lon2);
  const q2 = Math.cos(lat1 - lat2);
  const q3 = Math.cos(lat1 + lat2);
  // Inner term may exceed [-1, 1] by ULP-scale floating point error
  // when the two points coincide; clamp before passing it to acos.
  const inner = 0.5 * ((1 + q1) * q2 - (1 - q1) * q3);
  const clamped = Math.min(1, Math.max(-1, inner));
  return Math.trunc(TSPLIB_EARTH_RADIUS_KM * Math.acos(clamped) + 1);
}

/** Total GEO-distance length of a closed tour visiting `cities` in `tour` order. */
export function geoTourLength(
  cities: ReadonlyArray<TspCity>,
  tour: ReadonlyArray<number>,
): number {
  if (tour.length !== cities.length) {
    throw new Error(
      `geoTourLength: tour length ${tour.length} != cities length ${cities.length}`,
    );
  }
  if (cities.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < tour.length; i++) {
    const from = cities[tour[i]];
    const to = cities[tour[(i + 1) % tour.length]];
    total += geoDistance(from, to);
  }
  return total;
}

/** Outcome of a single constructive rollout. */
export interface ConstructiveEpisodeResult {
  /** Tour in visit order, starting with city 0. Length === cities.length. */
  readonly tour: ReadonlyArray<number>;
  /** Total GEO-distance length of the closed tour (kilometres). */
  readonly tourLength: number;
  /** Fitness score = `optimum / tourLength`, clamped above by `1.0`. */
  readonly fitness: number;
  /** Number of decision steps the agent actually took (= cities.length − 1). */
  readonly steps: number;
}

/** Options for {@link runConstructiveEpisode}. */
export interface ConstructiveEpisodeOptions {
  /** Index of the city to start the tour from. Defaults to `0`. */
  readonly startCity?: number;
  /**
   * Optional precomputed bounding-box diagonal — passing the cached value
   * spares recomputing it on every step. Defaults to
   * {@link boundingBoxDiagonal}.
   */
  readonly diagonal?: number;
}

/**
 * Run a single constructive-rollout episode against `activate`.
 *
 * The controller is queried `cities.length − 1` times. At each step the
 * agent observes the `K_NEAREST` unvisited cities relative to its
 * current position and commits to the slot picked by {@link decodeAction}.
 * After every city is visited the return edge to the starting city is
 * added to the total length.
 */
export function runConstructiveEpisode(
  activate: ActivateFn,
  cities: ReadonlyArray<TspCity>,
  optimum: number,
  options: ConstructiveEpisodeOptions = {},
): ConstructiveEpisodeResult {
  const n = cities.length;
  if (n === 0) {
    return { tour: [], tourLength: 0, fitness: 0, steps: 0 };
  }
  const start = options.startCity ?? 0;
  if (!Number.isInteger(start) || start < 0 || start >= n) {
    throw new Error(`startCity ${start} out of range for ${n} cities`);
  }
  const diagonal = options.diagonal ?? boundingBoxDiagonal(cities);

  const visited = new Array<boolean>(n).fill(false);
  visited[start] = true;
  const tour: number[] = [start];

  let current = start;
  let prevDx = 0;
  let prevDy = 0;
  let steps = 0;

  while (tour.length < n) {
    const candidates: Candidate[] = kNearestUnvisited(cities, current, visited);
    if (candidates.length === 0) {
      throw new Error(
        `runConstructiveEpisode: no unvisited candidates at step ${steps} (current=${current})`,
      );
    }
    const observation = encodeObservation(
      cities,
      current,
      candidates,
      [prevDx, prevDy],
      diagonal,
    );
    const rawOutputs = activate(observation);
    if (rawOutputs.length < K_NEAREST) {
      throw new Error(
        `runConstructiveEpisode: activate() returned ${rawOutputs.length} outputs, need at least ${K_NEAREST}`,
      );
    }
    const slot = decodeAction(rawOutputs, candidates);
    const next = candidates[slot].cityIndex;
    prevDx = cities[next].x - cities[current].x;
    prevDy = cities[next].y - cities[current].y;
    visited[next] = true;
    tour.push(next);
    current = next;
    steps++;
  }

  const length = geoTourLength(cities, tour);
  // Score is `optimum / length` clamped above by `1.0` so a near-optimal
  // tour cannot exceed the published GEO-distance reference. Length is
  // strictly positive whenever `n >= 2`.
  const rawFitness = length > 0 ? optimum / length : 0;
  const fitness = Math.min(1, rawFitness);
  return { tour, tourLength: length, fitness, steps };
}

/** Visit-set sanity helper used by tests and the runner — true when every
 * city in `tour` is unique and the set covers `[0, n)`. */
export function isCompleteTour(tour: ReadonlyArray<number>, n: number): boolean {
  if (tour.length !== n) return false;
  const seen = new Array<boolean>(n).fill(false);
  for (const idx of tour) {
    if (idx < 0 || idx >= n) return false;
    if (seen[idx]) return false;
    seen[idx] = true;
  }
  return true;
}
