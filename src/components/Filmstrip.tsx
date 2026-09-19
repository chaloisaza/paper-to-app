import { memo, useEffect, useRef } from "react";
import type { Version } from "../../shared/protocol";

export interface PendingCard {
  imageDataUrl: string | null;
  label: string;
}

interface FilmstripProps {
  versions: Version[];
  currentIndex: number;
  /** Ghost card for the run in flight. */
  pending: PendingCard | null;
  disabled: boolean;
  onSelect: (index: number) => void;
}

// Laid out three to a column, so the order here reads down first, then across.
const HINTS: ReadonlyArray<readonly [string, string]> = [
  ["Space", "capture"],
  ["← →", "versions"],
  ["V", "compare"],
  ["C", "code"],
  ["D", "download"],
  ["N", "new app"],
  ["Esc", "stop"],
];

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function describe(version: Version, index: number): string {
  const kind = version.mode === "iterate" ? "red pen" : version.mode === "fix" ? "fix" : "sketch";
  const tokens = version.usage.outputTokens.toLocaleString("en-US");
  return `v${index + 1} · ${kind}${version.replay ? " · replay" : ""} · ${seconds(version.ms)} · ${tokens} tokens`;
}

function BlankThumb() {
  return (
    <span className="flex h-full w-full items-center justify-center bg-linear-to-br from-raised to-panel text-white/25">
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        <path d="M3.5 9h17M7 13h5M7 16h8" />
      </svg>
    </span>
  );
}

function Tag({ tone, children }: { tone: string; children: string }) {
  return <span className={`rounded px-1 py-px text-[0.65rem] leading-tight font-semibold tracking-wide ${tone}`}>{children}</span>;
}

export const Filmstrip = memo(function Filmstrip({ versions, currentIndex, pending, disabled, onSelect }: FilmstripProps) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<HTMLDivElement>(null);
  const hasPending = pending !== null;

  useEffect(() => {
    const target = hasPending ? pendingRef.current : activeRef.current;
    target?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [versions.length, currentIndex, hasPending]);

  const empty = versions.length === 0 && !hasPending;

  return (
    <footer className="flex h-[6.5rem] shrink-0 items-stretch gap-4 border-t border-white/5 bg-panel/60 px-5 py-3 backdrop-blur">
      <div className="flex w-20 shrink-0 flex-col justify-center">
        <span className="text-[0.7rem] font-semibold tracking-[0.2em] text-white/55 uppercase">Versions</span>
        <span className="font-serif text-2xl text-paper tabular-nums italic">{versions.length}</span>
      </div>

      <div className="no-scrollbar flex min-w-0 flex-1 items-stretch gap-3 overflow-x-auto overflow-y-hidden scroll-smooth px-1 py-1">
        {empty && (
          <div className="flex items-center gap-3">
            {[0, 1, 2].map((slot) => (
              <span key={slot} className="aspect-[16/10] h-full rounded-xl border border-dashed border-white/10" />
            ))}
            <p className="pl-2 text-[0.95rem] text-white/55">Every version you build lands here. Click one to travel back.</p>
          </div>
        )}

        {versions.map((version, index) => {
          const active = index === currentIndex;
          return (
            <button
              key={version.id}
              ref={active ? activeRef : undefined}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(index)}
              title={describe(version, index)}
              aria-current={active}
              className={`group relative aspect-[16/10] h-full shrink-0 animate-card-in overflow-hidden rounded-xl transition duration-300 ease-out ${
                active
                  ? "opacity-100 ring-2 ring-paper"
                  : "opacity-55 ring-1 ring-white/10 enabled:hover:opacity-100 enabled:hover:ring-white/30"
              }`}
            >
              {version.imageDataUrl ? (
                <img src={version.imageDataUrl} alt={`Capture for version ${index + 1}`} draggable={false} className="h-full w-full object-cover" />
              ) : (
                <BlankThumb />
              )}
              <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-linear-to-t from-black/85 to-transparent px-1.5 pt-5 pb-1">
                <span
                  className={`rounded px-1 py-px text-[0.7rem] leading-tight font-bold tabular-nums transition-colors duration-300 ${
                    active ? "bg-paper text-ink" : "bg-black/60 text-paper"
                  }`}
                >
                  v{index + 1}
                </span>
                {version.mode === "iterate" && <Tag tone="bg-redpen text-white">red pen</Tag>}
                {version.mode === "fix" && <Tag tone="bg-glow text-ink">fix</Tag>}
                {version.replay && <Tag tone="bg-ember text-ink">replay</Tag>}
              </span>
            </button>
          );
        })}

        {pending && (
          <div
            ref={pendingRef}
            className="relative aspect-[16/10] h-full shrink-0 animate-card-in overflow-hidden rounded-xl ring-1 ring-glow/50"
          >
            {pending.imageDataUrl ? (
              <img src={pending.imageDataUrl} alt="" draggable={false} className="h-full w-full object-cover opacity-50" />
            ) : (
              <BlankThumb />
            )}
            <span className="absolute inset-y-0 left-0 w-1/2 animate-sheen bg-linear-to-r from-transparent via-white/25 to-transparent" />
            <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-linear-to-t from-black/85 to-transparent px-1.5 pt-5 pb-1">
              <span className="rounded bg-black/60 px-1 py-px text-[0.7rem] leading-tight font-bold text-paper tabular-nums">
                v{versions.length + 1}
              </span>
              <span className="shimmer-text text-[0.7rem] leading-tight font-semibold">{pending.label}</span>
            </span>
          </div>
        )}
      </div>

      <div className="hidden shrink-0 grid-flow-col grid-rows-3 content-center gap-x-5 gap-y-1 border-l border-white/5 pl-5 lg:grid">
        {HINTS.map(([key, action]) => (
          <span key={key} className="flex items-center gap-2 text-xs text-white/55">
            <kbd className="min-w-7 rounded-md bg-white/5 px-1.5 py-0.5 text-center font-mono text-[0.7rem] text-white/80 ring-1 ring-white/10">
              {key}
            </kbd>
            {action}
          </span>
        ))}
      </div>
    </footer>
  );
});
