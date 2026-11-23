import type { ReactNode } from "react";

/** A phone frame showing a Telegram-style conversation. Purely decorative; content is passed in as children. */
export function PhoneMock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[19rem] rounded-[2rem] border border-line bg-black p-2.5 shadow-2xl">
      <div className="overflow-hidden rounded-[1.5rem] bg-[#0e1621]">
        <div className="flex items-center gap-2 border-b border-white/10 bg-[#17212b] px-3 py-2.5">
          <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-full bg-accent text-xs font-bold text-accent-ink">
            n
          </span>
          <span className="text-sm font-semibold">{title}</span>
        </div>
        <div className="min-h-[16rem] space-y-2 p-3 text-[0.85rem] leading-snug">{children}</div>
      </div>
    </div>
  );
}

export function Bubble({ children }: { children: ReactNode }) {
  return <div className="max-w-full rounded-2xl rounded-bl-md bg-[#182533] px-3 py-2">{children}</div>;
}
