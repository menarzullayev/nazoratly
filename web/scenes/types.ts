export type Vec3 = readonly [number, number, number];

/**
 * `progress.current` is the scroll progress 0..1, updated by ScrollStage every frame.
 * A ref (not a number prop) so WebGL scenes read it inside their render loop without re-rendering React.
 */
export interface SceneProps {
  progress: { current: number };
  accent: string;
  /** Called when the WebGL context is lost so the host can switch to the fallback. */
  onLost?: () => void;
}

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
