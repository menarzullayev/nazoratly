/** Brand mark: an eye (oversight) with an accent pupil, then the name as real text. */
export function Wordmark({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" focusable="false">
        <path d="M2 13s4.2-7.5 11-7.5S24 13 24 13s-4.2 7.5-11 7.5S2 13 2 13Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <circle cx="13" cy="13" r="3.6" fill="var(--accent)" />
      </svg>
      <span className="font-display text-[1.05rem] font-semibold tracking-tight">{name}</span>
    </span>
  );
}
