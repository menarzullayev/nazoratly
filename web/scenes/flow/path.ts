import type { Vec3 } from "../types";

export const ANCHORS = {
  sheet: [-6, 0, 0],
  bot: [0, 1.5, 0],
  phone: [6, 0.5, 0],
} as const satisfies Record<string, Vec3>;

/** Control points, evenly spaced in x so the path always moves left to right. */
const POINTS: Vec3[] = [
  ANCHORS.sheet,
  [-3, 0.9, 0.8],
  ANCHORS.bot,
  [3, 1.1, -0.6],
  ANCHORS.phone,
];

const P = (i: number): Vec3 => POINTS[Math.max(0, Math.min(POINTS.length - 1, i))]!;

function cr(p0: number, p1: number, p2: number, p3: number, u: number): number {
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
}

/** Point on the Sheet -> bot -> phone path for t in 0..1 (uniform Catmull-Rom through the control points). */
export function flowPoint(t: number): Vec3 {
  const x = Math.min(1, Math.max(0, t));
  if (x === 0) return ANCHORS.sheet;
  if (x === 1) return ANCHORS.phone;
  const segs = POINTS.length - 1;
  const f = x * segs;
  const i = Math.min(segs - 1, Math.floor(f));
  const u = f - i;
  const a = P(i - 1), b = P(i), c = P(i + 1), d = P(i + 2);
  return [cr(a[0], b[0], c[0], d[0], u), cr(a[1], b[1], c[1], d[1], u), cr(a[2], b[2], c[2], d[2], u)];
}
