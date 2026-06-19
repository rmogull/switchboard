/**
 * Time is injectable so the state layer, approval timeouts, and the
 * coordination FSM are deterministically testable. Production uses the system
 * clock; tests pass a controllable clock.
 */
export interface Clock {
  /** Milliseconds since the unix epoch. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A clock you can advance by hand in tests. */
export function fixedClock(startMs: number): Clock & { advance(ms: number): void } {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}
