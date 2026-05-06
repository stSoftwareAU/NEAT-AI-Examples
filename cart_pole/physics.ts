/**
 * Deterministic 2D cart-pole physics.
 *
 * Standard textbook formulation: a frictionless cart of mass `cartMass`
 * slides along a horizontal track. A pole of mass `poleMass` and
 * half-length `poleHalfLength` is hinged on top of the cart. A horizontal
 * force `force` is applied to the cart. Gravity acts downward on the
 * pole. Equations follow Florian (2007) and are the same as the
 * OpenAI Gym `CartPole-v1` reference implementation, expressed as pure
 * functions so simulations are reproducible across runs.
 *
 * Coordinate system:
 *   - `x`: cart position along the track (metres). Positive = right.
 *   - `v`: cart velocity (metres per second).
 *   - `theta`: pole angle from the upright vertical (radians). Positive =
 *     leaning right.
 *   - `omega`: pole angular velocity (radians per second).
 */

/** Immutable cart-pole state vector. */
export interface CartPoleState {
  /** Cart position along the track (metres). */
  x: number;
  /** Cart velocity (metres per second). */
  v: number;
  /** Pole angle from vertical (radians). */
  theta: number;
  /** Pole angular velocity (radians per second). */
  omega: number;
}

/** Physical parameters of the cart-pole system. */
export interface CartPoleParams {
  /** Gravitational acceleration (m/s^2). */
  gravity: number;
  /** Cart mass (kg). */
  cartMass: number;
  /** Pole mass (kg). */
  poleMass: number;
  /** Half the pole's length (m). */
  poleHalfLength: number;
  /** Magnitude of the applied horizontal force (N). */
  forceMagnitude: number;
  /** Simulation time step (seconds). */
  timeStep: number;
}

/**
 * Default physical parameters. These match the canonical CartPole-v1
 * benchmark used in the neuroevolution literature.
 */
export const DEFAULT_PARAMS: CartPoleParams = {
  gravity: 9.8,
  cartMass: 1.0,
  poleMass: 0.1,
  poleHalfLength: 0.5,
  forceMagnitude: 10.0,
  timeStep: 0.02,
};

/** Threshold beyond which the cart-pole episode is considered failed. */
export interface CartPoleLimits {
  /** Maximum absolute pole angle (radians) before failure. */
  maxAngle: number;
  /** Maximum absolute cart position (m) before failure. */
  maxPosition: number;
}

/** Default failure thresholds: ~12 degrees angle, 2.4 m track half-width. */
export const DEFAULT_LIMITS: CartPoleLimits = {
  maxAngle: 12 * Math.PI / 180,
  maxPosition: 2.4,
};

/** Initial state with the cart centred and the pole upright. */
export function initialState(): CartPoleState {
  return { x: 0, v: 0, theta: 0, omega: 0 };
}

/**
 * Advance the cart-pole simulation by one time step using semi-implicit
 * Euler integration.
 *
 * @param state Current state of the system.
 * @param action Direction of the applied force: -1 pushes left, +1 pushes
 *               right. Any non-zero numeric value is normalised by sign.
 * @param params Physical parameters (defaults to {@link DEFAULT_PARAMS}).
 * @returns The state after one time step. The input state is not mutated.
 */
export function step(
  state: CartPoleState,
  action: number,
  params: CartPoleParams = DEFAULT_PARAMS,
): CartPoleState {
  const force = (action >= 0 ? 1 : -1) * params.forceMagnitude;
  const totalMass = params.cartMass + params.poleMass;
  const polemassLength = params.poleMass * params.poleHalfLength;

  const cosTheta = Math.cos(state.theta);
  const sinTheta = Math.sin(state.theta);

  // Equations from Florian (2007). The temp term is a partial
  // acceleration that lets us decouple the two coordinate accelerations.
  const temp = (force + polemassLength * state.omega * state.omega * sinTheta) /
    totalMass;
  const thetaAcc = (params.gravity * sinTheta - cosTheta * temp) /
    (params.poleHalfLength *
      (4.0 / 3.0 - (params.poleMass * cosTheta * cosTheta) / totalMass));
  const xAcc = temp - (polemassLength * thetaAcc * cosTheta) / totalMass;

  // Semi-implicit Euler: update velocity first, then position. This is
  // the same scheme used by OpenAI Gym for CartPole-v1.
  const newV = state.v + params.timeStep * xAcc;
  const newX = state.x + params.timeStep * newV;
  const newOmega = state.omega + params.timeStep * thetaAcc;
  const newTheta = state.theta + params.timeStep * newOmega;

  return { x: newX, v: newV, theta: newTheta, omega: newOmega };
}

/**
 * Returns true when the state has exceeded the failure thresholds — i.e.
 * the pole has fallen past the angle limit or the cart has run off the
 * track.
 */
export function isFailed(
  state: CartPoleState,
  limits: CartPoleLimits = DEFAULT_LIMITS,
): boolean {
  return (
    Math.abs(state.theta) > limits.maxAngle ||
    Math.abs(state.x) > limits.maxPosition
  );
}

/**
 * Encode a {@link CartPoleState} as a Float32Array suitable for feeding
 * to a NEAT-AI creature: `[x, v, theta, omega]`.
 */
export function encodeState(state: CartPoleState): Float32Array {
  return new Float32Array([state.x, state.v, state.theta, state.omega]);
}
