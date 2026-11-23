import type { Vec3 } from "../types";

/** Small deterministic PRNG so the same seed always scatters the cards the same way. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const GRID_DX = 1.5;
export const GRID_DY = 1.0;

/** Scattered positions (chaos) and the tidy grid they settle into (order), for n cards. */
export function layoutChaos(n: number, seed: number): { chaos: Vec3[]; order: Vec3[] } {
  if (n <= 0) return { chaos: [], order: [] };
  const rnd = mulberry32(seed);
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.5)));
  const rows = Math.ceil(n / cols);
  const order: Vec3[] = [];
  const chaos: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    order.push([(c - (cols - 1) / 2) * GRID_DX, ((rows - 1) / 2 - r) * GRID_DY, 0]);
  }
  for (let i = 0; i < n; i++) {
    chaos.push([(rnd() - 0.5) * 18, (rnd() - 0.5) * 10, (rnd() - 0.7) * 9]);
  }
  return { chaos, order };
}
