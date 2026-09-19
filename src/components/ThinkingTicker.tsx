import { useLayoutEffect, useRef, useState } from "react";

interface ThinkingTickerProps {
  active: boolean;
  /** Summarized thinking streamed so far; only the tail is shown. */
  thinking: string;
  /** Shown with a shimmer until the first thinking text arrives. */
  label: string;
}

const TAIL_CHARS = 360;

export function ThinkingTicker({ active, thinking, label }: ThinkingTickerProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const tail = thinking.replace(/\s+/g, " ").trim().slice(-TAIL_CHARS);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const textEl = textRef.current;
    setOverflowing(Boolean(track && textEl && textEl.scrollWidth > track.clientWidth + 1));
  }, [tail]);

  return (
    <div
      aria-hidden={!active}
      className={`pointer-events-none absolute inset-x-4 bottom-4 z-20 transition duration-300 ease-out ${
        active ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
      }`}
    >
      <div className="relative overflow-hidden rounded-2xl bg-ink/70 shadow-[0_12px_48px_-12px] shadow-glow/40 ring-1 ring-white/10 backdrop-blur-xl">
        <div className="absolute inset-y-0 left-0 w-1/3 animate-sheen bg-linear-to-r from-transparent via-glow/15 to-transparent" />
        <div className="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-glow/60 to-transparent" />
        <div className="relative flex items-center gap-4 px-5 py-3.5">
          <span className="relative flex h-3 w-3 shrink-0">
            <span className="absolute inset-0 animate-ping rounded-full bg-glow/70" />
            <span className="relative h-3 w-3 rounded-full bg-glow shadow-[0_0_12px_2px] shadow-glow/60" />
          </span>
          {tail ? (
            <div
              ref={trackRef}
              className="flex min-w-0 flex-1 justify-end overflow-hidden"
              style={
                overflowing
                  ? {
                      maskImage: "linear-gradient(90deg, transparent, #000 4rem)",
                      WebkitMaskImage: "linear-gradient(90deg, transparent, #000 4rem)",
                    }
                  : undefined
              }
            >
              <p ref={textRef} className="min-w-full shrink-0 text-left text-base leading-6 whitespace-nowrap text-white/80">
                {tail}
                <span className="ml-1 inline-block h-4 w-0.5 translate-y-0.5 animate-blink bg-glow" />
              </p>
            </div>
          ) : (
            <p className="shimmer-text min-w-0 flex-1 truncate text-base leading-6 font-medium">{label}</p>
          )}
          <span className="shrink-0 text-[0.65rem] font-semibold tracking-[0.2em] text-glow/80 uppercase">Thinking</span>
        </div>
      </div>
    </div>
  );
}
