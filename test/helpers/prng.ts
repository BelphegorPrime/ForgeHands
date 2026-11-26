// @ts-nocheck -- test helper, loose like the fakes it serves.
// A small seeded pseudo-random generator (mulberry32) for the replay tests: the same seed gives the same sequence, so a failing run can be
// replayed from the seed it prints. Hand-written instead of a package, like everything else in ForgeHands.
export function prng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (below) => Math.floor(next() * below),
    pick: (list) => list[Math.floor(next() * list.length)]
  };
}
