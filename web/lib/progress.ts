/** Mutable scroll-progress holder shared with WebGL scenes (read inside their render loop, never in React render). */
export interface Progress {
  current: number;
}

export const createProgress = (initial: number): Progress => ({ current: initial });

/** Writes the scroll progress to the holder, the `--p` CSS variable and `data-progress` of the stage element. */
export function applyProgress(holder: Progress, el: HTMLElement | null, p: number): void {
  holder.current = p;
  if (!el) return;
  el.style.setProperty("--p", String(p));
  el.dataset.progress = p.toFixed(3);
}
