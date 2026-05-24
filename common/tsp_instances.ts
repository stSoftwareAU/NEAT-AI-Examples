/**
 * Shared TSPLIB instance data and tour helpers for travelling-salesperson
 * demos.
 *
 * Both `tsp_constructive` and `tsp_two_opt` (planned under issue #456) need
 * the same city coordinates and the same tour-length arithmetic. This module
 * centralises that data so the two examples cannot drift out of sync.
 *
 * Coordinates for `burma14` (14 cities, published optimum 3,323),
 * `ulysses22` (22 cities, published optimum 7,013) and `pcb442` (442 cities,
 * published optimum 50,778) are embedded as literal arrays — there is **no
 * network fetch at runtime**, in keeping with the repository's
 * no-external-dependencies-at-runtime policy.
 *
 * Source: TSPLIB95 instance library,
 * <http://comopt.ifi.uni-heidelberg.de/software/TSPLIB95/>.
 *
 * Distances are computed in plain two-dimensional Euclidean space: tour
 * lengths produced by {@link tourLength} therefore differ from the published
 * TSPLIB GEO-distance optima, which remain available via
 * {@link loadInstance} for callers that want a stable reference value.
 */

/** Two-dimensional city coordinate (units are the raw TSPLIB values). */
export interface TspCity {
  readonly x: number;
  readonly y: number;
}

/** Embedded TSPLIB instance: name, ordered city coordinates and optimum. */
export interface TspInstance {
  readonly name: string;
  readonly cities: ReadonlyArray<TspCity>;
  /** Published TSPLIB optimum (GEO distance) — retained as a reference. */
  readonly optimum: number;
}

/** Names of the embedded TSPLIB instances. */
export type TspInstanceName = "burma14" | "ulysses22" | "pcb442";

// TSPLIB95 burma14 NODE_COORD_SECTION (14 cities in Burma / Myanmar).
const BURMA14: ReadonlyArray<TspCity> = [
  { x: 16.47, y: 96.10 },
  { x: 16.47, y: 94.44 },
  { x: 20.09, y: 92.54 },
  { x: 22.39, y: 93.37 },
  { x: 25.23, y: 97.24 },
  { x: 22.00, y: 96.05 },
  { x: 20.47, y: 97.02 },
  { x: 17.20, y: 96.29 },
  { x: 16.30, y: 97.38 },
  { x: 14.05, y: 98.12 },
  { x: 16.53, y: 97.38 },
  { x: 21.52, y: 95.59 },
  { x: 19.41, y: 97.13 },
  { x: 20.09, y: 94.55 },
];

// TSPLIB95 ulysses22 NODE_COORD_SECTION (22 cities, Mediterranean coastline).
const ULYSSES22: ReadonlyArray<TspCity> = [
  { x: 38.24, y: 20.42 },
  { x: 39.57, y: 26.15 },
  { x: 40.56, y: 25.32 },
  { x: 36.26, y: 23.12 },
  { x: 33.48, y: 10.54 },
  { x: 37.56, y: 12.19 },
  { x: 38.42, y: 13.11 },
  { x: 37.52, y: 20.44 },
  { x: 41.23, y: 9.10 },
  { x: 41.17, y: 13.05 },
  { x: 36.08, y: -5.21 },
  { x: 38.47, y: 15.13 },
  { x: 38.15, y: 15.35 },
  { x: 37.51, y: 15.17 },
  { x: 35.49, y: 14.32 },
  { x: 39.36, y: 19.56 },
  { x: 38.09, y: 24.36 },
  { x: 36.09, y: 23.00 },
  { x: 40.44, y: 13.57 },
  { x: 40.33, y: 14.15 },
  { x: 40.37, y: 14.23 },
  { x: 37.57, y: 22.56 },
];

// TSPLIB95 pcb442 NODE_COORD_SECTION (442 cities, printed-circuit-board
// drilling problem by Groetschel, Juenger, Reinelt). City order matches the
// canonical TSPLIB95 file exactly so any downstream comparison to published
// tours stays meaningful.
const PCB442: ReadonlyArray<TspCity> = [
  { x: 200, y: 400 },
  { x: 200, y: 500 },
  { x: 200, y: 600 },
  { x: 200, y: 700 },
  { x: 200, y: 800 },
  { x: 200, y: 900 },
  { x: 200, y: 1000 },
  { x: 200, y: 1100 },
  { x: 200, y: 1200 },
  { x: 200, y: 1300 },
  { x: 200, y: 1400 },
  { x: 200, y: 1500 },
  { x: 200, y: 1600 },
  { x: 200, y: 1700 },
  { x: 200, y: 1800 },
  { x: 200, y: 1900 },
  { x: 200, y: 2000 },
  { x: 200, y: 2100 },
  { x: 200, y: 2200 },
  { x: 200, y: 2300 },
  { x: 200, y: 2400 },
  { x: 200, y: 2500 },
  { x: 200, y: 2600 },
  { x: 200, y: 2700 },
  { x: 200, y: 2800 },
  { x: 200, y: 2900 },
  { x: 200, y: 3000 },
  { x: 200, y: 3100 },
  { x: 200, y: 3200 },
  { x: 200, y: 3300 },
  { x: 200, y: 3400 },
  { x: 200, y: 3500 },
  { x: 200, y: 3600 },
  { x: 300, y: 400 },
  { x: 300, y: 500 },
  { x: 300, y: 600 },
  { x: 300, y: 700 },
  { x: 300, y: 800 },
  { x: 300, y: 900 },
  { x: 300, y: 1000 },
  { x: 300, y: 1100 },
  { x: 300, y: 1200 },
  { x: 300, y: 1300 },
  { x: 300, y: 1400 },
  { x: 300, y: 1500 },
  { x: 300, y: 1600 },
  { x: 300, y: 1700 },
  { x: 300, y: 1800 },
  { x: 300, y: 1900 },
  { x: 300, y: 2000 },
  { x: 300, y: 2100 },
  { x: 300, y: 2200 },
  { x: 300, y: 2300 },
  { x: 300, y: 2400 },
  { x: 300, y: 2500 },
  { x: 300, y: 2600 },
  { x: 300, y: 2700 },
  { x: 300, y: 2800 },
  { x: 300, y: 2900 },
  { x: 300, y: 3000 },
  { x: 300, y: 3100 },
  { x: 300, y: 3200 },
  { x: 300, y: 3300 },
  { x: 300, y: 3400 },
  { x: 300, y: 3500 },
  { x: 400, y: 400 },
  { x: 400, y: 500 },
  { x: 400, y: 600 },
  { x: 400, y: 700 },
  { x: 400, y: 800 },
  { x: 400, y: 900 },
  { x: 400, y: 1000 },
  { x: 400, y: 1100 },
  { x: 400, y: 1200 },
  { x: 400, y: 1300 },
  { x: 400, y: 1400 },
  { x: 400, y: 1500 },
  { x: 400, y: 1600 },
  { x: 400, y: 1700 },
  { x: 400, y: 1800 },
  { x: 400, y: 1900 },
  { x: 400, y: 2000 },
  { x: 400, y: 2100 },
  { x: 400, y: 2200 },
  { x: 400, y: 2300 },
  { x: 400, y: 2400 },
  { x: 400, y: 2500 },
  { x: 400, y: 2600 },
  { x: 400, y: 2700 },
  { x: 400, y: 2800 },
  { x: 400, y: 2900 },
  { x: 400, y: 3000 },
  { x: 400, y: 3100 },
  { x: 400, y: 3200 },
  { x: 400, y: 3300 },
  { x: 400, y: 3400 },
  { x: 400, y: 3500 },
  { x: 400, y: 3600 },
  { x: 500, y: 1500 },
  { x: 500, y: 1829 },
  { x: 500, y: 3100 },
  { x: 600, y: 400 },
  { x: 700, y: 300 },
  { x: 700, y: 600 },
  { x: 700, y: 1500 },
  { x: 700, y: 1600 },
  { x: 700, y: 1800 },
  { x: 700, y: 2100 },
  { x: 700, y: 2400 },
  { x: 700, y: 2700 },
  { x: 700, y: 3000 },
  { x: 700, y: 3300 },
  { x: 700, y: 3600 },
  { x: 800, y: 300 },
  { x: 800, y: 600 },
  { x: 800, y: 1030 },
  { x: 800, y: 1500 },
  { x: 800, y: 1800 },
  { x: 800, y: 2100 },
  { x: 800, y: 2400 },
  { x: 800, y: 2600 },
  { x: 800, y: 2700 },
  { x: 800, y: 3000 },
  { x: 800, y: 3300 },
  { x: 800, y: 3600 },
  { x: 900, y: 300 },
  { x: 900, y: 600 },
  { x: 900, y: 1500 },
  { x: 900, y: 1800 },
  { x: 900, y: 2100 },
  { x: 900, y: 2400 },
  { x: 900, y: 2700 },
  { x: 900, y: 3000 },
  { x: 900, y: 3300 },
  { x: 900, y: 3600 },
  { x: 1000, y: 300 },
  { x: 1000, y: 600 },
  { x: 1000, y: 1100 },
  { x: 1000, y: 1500 },
  { x: 1000, y: 1629 },
  { x: 1000, y: 1800 },
  { x: 1000, y: 2100 },
  { x: 1000, y: 2400 },
  { x: 1000, y: 2600 },
  { x: 1000, y: 2700 },
  { x: 1000, y: 3000 },
  { x: 1000, y: 3300 },
  { x: 1000, y: 3600 },
  { x: 1100, y: 300 },
  { x: 1100, y: 600 },
  { x: 1100, y: 700 },
  { x: 1100, y: 900 },
  { x: 1100, y: 1500 },
  { x: 1100, y: 1800 },
  { x: 1100, y: 2100 },
  { x: 1100, y: 2400 },
  { x: 1100, y: 2700 },
  { x: 1100, y: 3000 },
  { x: 1100, y: 3300 },
  { x: 1100, y: 3600 },
  { x: 1200, y: 300 },
  { x: 1200, y: 600 },
  { x: 1200, y: 1500 },
  { x: 1200, y: 1700 },
  { x: 1200, y: 1800 },
  { x: 1200, y: 2100 },
  { x: 1200, y: 2400 },
  { x: 1200, y: 2700 },
  { x: 1200, y: 3000 },
  { x: 1200, y: 3300 },
  { x: 1200, y: 3600 },
  { x: 1300, y: 300 },
  { x: 1300, y: 600 },
  { x: 1300, y: 700 },
  { x: 1300, y: 1130 },
  { x: 1300, y: 1500 },
  { x: 1300, y: 1800 },
  { x: 1300, y: 2100 },
  { x: 1300, y: 2200 },
  { x: 1300, y: 2400 },
  { x: 1300, y: 2700 },
  { x: 1300, y: 3000 },
  { x: 1300, y: 3300 },
  { x: 1300, y: 3600 },
  { x: 1400, y: 300 },
  { x: 1400, y: 600 },
  { x: 1400, y: 930 },
  { x: 1400, y: 1500 },
  { x: 1400, y: 1800 },
  { x: 1400, y: 2000 },
  { x: 1400, y: 2100 },
  { x: 1400, y: 2400 },
  { x: 1400, y: 2500 },
  { x: 1400, y: 2700 },
  { x: 1400, y: 2820 },
  { x: 1400, y: 2900 },
  { x: 1400, y: 3000 },
  { x: 1400, y: 3300 },
  { x: 1400, y: 3600 },
  { x: 1500, y: 1500 },
  { x: 1500, y: 1800 },
  { x: 1500, y: 1900 },
  { x: 1500, y: 2100 },
  { x: 1500, y: 2400 },
  { x: 1500, y: 2700 },
  { x: 1500, y: 2800 },
  { x: 1500, y: 2860 },
  { x: 1500, y: 3000 },
  { x: 1500, y: 3300 },
  { x: 1500, y: 3600 },
  { x: 1600, y: 1100 },
  { x: 1600, y: 1300 },
  { x: 1600, y: 1500 },
  { x: 1600, y: 1800 },
  { x: 1600, y: 2100 },
  { x: 1600, y: 2400 },
  { x: 1600, y: 2700 },
  { x: 1600, y: 3000 },
  { x: 1600, y: 3300 },
  { x: 1600, y: 3600 },
  { x: 1700, y: 1200 },
  { x: 1700, y: 1500 },
  { x: 1700, y: 1800 },
  { x: 1700, y: 2100 },
  { x: 1700, y: 2400 },
  { x: 1700, y: 3600 },
  { x: 1800, y: 300 },
  { x: 1800, y: 600 },
  { x: 1800, y: 1230 },
  { x: 1800, y: 1500 },
  { x: 1800, y: 1800 },
  { x: 1800, y: 2100 },
  { x: 1800, y: 2400 },
  { x: 1900, y: 300 },
  { x: 1900, y: 600 },
  { x: 1900, y: 3000 },
  { x: 1900, y: 3520 },
  { x: 2000, y: 300 },
  { x: 2000, y: 370 },
  { x: 2000, y: 600 },
  { x: 2000, y: 800 },
  { x: 2000, y: 900 },
  { x: 2000, y: 1000 },
  { x: 2000, y: 1100 },
  { x: 2000, y: 1200 },
  { x: 2000, y: 1300 },
  { x: 2000, y: 1400 },
  { x: 2000, y: 1500 },
  { x: 2000, y: 1600 },
  { x: 2000, y: 1700 },
  { x: 2000, y: 1800 },
  { x: 2000, y: 1900 },
  { x: 2000, y: 2000 },
  { x: 2000, y: 2100 },
  { x: 2000, y: 2200 },
  { x: 2000, y: 2300 },
  { x: 2000, y: 2400 },
  { x: 2000, y: 2500 },
  { x: 2000, y: 2600 },
  { x: 2000, y: 2700 },
  { x: 2000, y: 2800 },
  { x: 2000, y: 2900 },
  { x: 2000, y: 3000 },
  { x: 2000, y: 3100 },
  { x: 2000, y: 3500 },
  { x: 2100, y: 300 },
  { x: 2100, y: 600 },
  { x: 2100, y: 3200 },
  { x: 2200, y: 300 },
  { x: 2200, y: 469 },
  { x: 2200, y: 600 },
  { x: 2200, y: 3200 },
  { x: 2300, y: 300 },
  { x: 2300, y: 600 },
  { x: 2300, y: 3400 },
  { x: 2400, y: 300 },
  { x: 2400, y: 600 },
  { x: 2400, y: 2100 },
  { x: 2500, y: 300 },
  { x: 2500, y: 800 },
  { x: 2600, y: 400 },
  { x: 2600, y: 500 },
  { x: 2600, y: 800 },
  { x: 2600, y: 900 },
  { x: 2600, y: 1000 },
  { x: 2600, y: 1100 },
  { x: 2600, y: 1200 },
  { x: 2600, y: 1300 },
  { x: 2600, y: 1400 },
  { x: 2600, y: 1500 },
  { x: 2600, y: 1600 },
  { x: 2600, y: 1700 },
  { x: 2600, y: 1800 },
  { x: 2600, y: 1900 },
  { x: 2600, y: 2000 },
  { x: 2600, y: 2100 },
  { x: 2600, y: 2200 },
  { x: 2600, y: 2300 },
  { x: 2600, y: 2400 },
  { x: 2600, y: 2500 },
  { x: 2600, y: 2600 },
  { x: 2600, y: 2700 },
  { x: 2600, y: 2800 },
  { x: 2600, y: 2900 },
  { x: 2600, y: 3000 },
  { x: 2600, y: 3100 },
  { x: 2600, y: 3400 },
  { x: 2700, y: 700 },
  { x: 2700, y: 800 },
  { x: 2700, y: 900 },
  { x: 2700, y: 1000 },
  { x: 2700, y: 1100 },
  { x: 2700, y: 1200 },
  { x: 2700, y: 1300 },
  { x: 2700, y: 1400 },
  { x: 2700, y: 1500 },
  { x: 2700, y: 1600 },
  { x: 2700, y: 1700 },
  { x: 2700, y: 1800 },
  { x: 2700, y: 1900 },
  { x: 2700, y: 2000 },
  { x: 2700, y: 2100 },
  { x: 2700, y: 2200 },
  { x: 2700, y: 2300 },
  { x: 2700, y: 2500 },
  { x: 2700, y: 2600 },
  { x: 2700, y: 2700 },
  { x: 2700, y: 2800 },
  { x: 2700, y: 2900 },
  { x: 2700, y: 3000 },
  { x: 2700, y: 3100 },
  { x: 2700, y: 3200 },
  { x: 2700, y: 3300 },
  { x: 2700, y: 3400 },
  { x: 2700, y: 3500 },
  { x: 2700, y: 3600 },
  { x: 2700, y: 3700 },
  { x: 2700, y: 3800 },
  { x: 2800, y: 900 },
  { x: 2800, y: 1130 },
  { x: 2900, y: 400 },
  { x: 2900, y: 500 },
  { x: 2900, y: 1400 },
  { x: 2900, y: 2400 },
  { x: 2900, y: 3000 },
  { x: 3000, y: 700 },
  { x: 3000, y: 800 },
  { x: 3000, y: 900 },
  { x: 3000, y: 1000 },
  { x: 3000, y: 1100 },
  { x: 3000, y: 1200 },
  { x: 3000, y: 1300 },
  { x: 3000, y: 1500 },
  { x: 3000, y: 1600 },
  { x: 3000, y: 1700 },
  { x: 3000, y: 1800 },
  { x: 3000, y: 1900 },
  { x: 3000, y: 2000 },
  { x: 3000, y: 2100 },
  { x: 3000, y: 2200 },
  { x: 3000, y: 2300 },
  { x: 3000, y: 2500 },
  { x: 3000, y: 2600 },
  { x: 3000, y: 2700 },
  { x: 3000, y: 2800 },
  { x: 3000, y: 2900 },
  { x: 3000, y: 3000 },
  { x: 3000, y: 3100 },
  { x: 3000, y: 3200 },
  { x: 3000, y: 3300 },
  { x: 3000, y: 3400 },
  { x: 3000, y: 3500 },
  { x: 3000, y: 3600 },
  { x: 3000, y: 3700 },
  { x: 3000, y: 3800 },
  { x: 150, y: 3500 },
  { x: 150, y: 3550 },
  { x: 469, y: 2550 },
  { x: 469, y: 3350 },
  { x: 469, y: 3450 },
  { x: 540, y: 2330 },
  { x: 540, y: 2430 },
  { x: 620, y: 3650 },
  { x: 620, y: 3709 },
  { x: 750, y: 2550 },
  { x: 850, y: 520 },
  { x: 850, y: 700 },
  { x: 850, y: 2280 },
  { x: 939, y: 740 },
  { x: 950, y: 2220 },
  { x: 910, y: 2600 },
  { x: 1050, y: 1050 },
  { x: 1150, y: 1350 },
  { x: 1170, y: 2280 },
  { x: 1220, y: 2210 },
  { x: 1350, y: 750 },
  { x: 1350, y: 1700 },
  { x: 1350, y: 2140 },
  { x: 1450, y: 770 },
  { x: 1550, y: 300 },
  { x: 1550, y: 500 },
  { x: 1550, y: 1850 },
  { x: 1650, y: 1050 },
  { x: 1690, y: 2680 },
  { x: 1710, y: 310 },
  { x: 1710, y: 510 },
  { x: 1750, y: 750 },
  { x: 1790, y: 2580 },
  { x: 1720, y: 2610 },
  { x: 1790, y: 3330 },
  { x: 1720, y: 3409 },
  { x: 1829, y: 2700 },
  { x: 1829, y: 2800 },
  { x: 1829, y: 3450 },
  { x: 2060, y: 1650 },
  { x: 2050, y: 3150 },
  { x: 2170, y: 1900 },
  { x: 2110, y: 2000 },
  { x: 2120, y: 2750 },
  { x: 2150, y: 3250 },
  { x: 2290, y: 1400 },
  { x: 2220, y: 2820 },
  { x: 2280, y: 3250 },
  { x: 2390, y: 1300 },
  { x: 2320, y: 1500 },
  { x: 2450, y: 710 },
  { x: 2620, y: 3650 },
  { x: 2750, y: 520 },
  { x: 2760, y: 2360 },
  { x: 2850, y: 2200 },
  { x: 2850, y: 2700 },
  { x: 2850, y: 3350 },
  { x: 2930, y: 950 },
  { x: 2950, y: 1750 },
  { x: 2950, y: 2050 },
  { x: 520, y: 3200 },
  { x: 2300, y: 3500 },
  { x: 2320, y: 3150 },
  { x: 530, y: 2100 },
  { x: 2550, y: 710 },
  { x: 750, y: 490 },
  { x: 0, y: 0 },
];

const INSTANCES: Readonly<Record<TspInstanceName, TspInstance>> = {
  burma14: { name: "burma14", cities: BURMA14, optimum: 3323 },
  ulysses22: { name: "ulysses22", cities: ULYSSES22, optimum: 7013 },
  pcb442: { name: "pcb442", cities: PCB442, optimum: 50778 },
};

/**
 * Return the embedded instance with the given name. The returned object is
 * shared — callers must not mutate the `cities` array.
 */
export function loadInstance(name: TspInstanceName): TspInstance {
  const instance = INSTANCES[name];
  if (!instance) {
    throw new Error(`Unknown TSPLIB instance: ${name}`);
  }
  return instance;
}

/** Plain two-dimensional Euclidean distance between two cities. */
export function euclideanDistance(a: TspCity, b: TspCity): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Total Euclidean length of a closed tour visiting `cities` in the order
 * given by `tourOrder` and returning to the starting city. `tourOrder` must
 * be a permutation of `[0, cities.length)`.
 */
export function tourLength(
  cities: ReadonlyArray<TspCity>,
  tourOrder: ReadonlyArray<number>,
): number {
  if (tourOrder.length !== cities.length) {
    throw new Error(
      `tourOrder length ${tourOrder.length} does not match cities length ${cities.length}`,
    );
  }
  if (cities.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < tourOrder.length; i++) {
    const from = cities[tourOrder[i]];
    const to = cities[tourOrder[(i + 1) % tourOrder.length]];
    if (!from || !to) {
      throw new Error(`tourOrder contains out-of-range index near position ${i}`);
    }
    total += euclideanDistance(from, to);
  }
  return total;
}

/**
 * Diagonal of the axis-aligned bounding box that encloses every city. Useful
 * as a normalisation constant when feeding raw coordinates into a neural net
 * (the longest possible single edge cannot exceed this value).
 */
export function boundingBoxDiagonal(cities: ReadonlyArray<TspCity>): number {
  if (cities.length === 0) return 0;
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
  const dx = maxX - minX;
  const dy = maxY - minY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Deterministic nearest-neighbour tour starting at `startIndex`. At each
 * step the next unvisited city with the smallest Euclidean distance is
 * chosen; ties are broken by lower city index, so the same `cities` and
 * `startIndex` always return the same permutation.
 */
export function nearestNeighbourTour(
  cities: ReadonlyArray<TspCity>,
  startIndex: number = 0,
): number[] {
  const n = cities.length;
  if (n === 0) return [];
  if (startIndex < 0 || startIndex >= n || !Number.isInteger(startIndex)) {
    throw new Error(`startIndex ${startIndex} out of range for ${n} cities`);
  }
  const visited = new Array<boolean>(n).fill(false);
  const tour: number[] = [startIndex];
  visited[startIndex] = true;
  let current = startIndex;
  for (let step = 1; step < n; step++) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let candidate = 0; candidate < n; candidate++) {
      if (visited[candidate]) continue;
      const d = euclideanDistance(cities[current], cities[candidate]);
      // Strict `<` keeps the lowest-index city on ties — deterministic.
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = candidate;
      }
    }
    tour.push(bestIndex);
    visited[bestIndex] = true;
    current = bestIndex;
  }
  return tour;
}
