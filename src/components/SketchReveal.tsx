import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

// Overlay chrome for the preview stage. Two pieces, both purely visual:
//   SketchReveal — the captured photo being "read" while the app has not painted anything yet,
//                  wiping downward the moment markup starts landing.
//   CompareWipe  — a draggable sketch/app split once a version is finished.
// Neither touches the iframe, the stream or the message protocol.

/** How long the hand-off wipe takes. PreviewFrame keeps the overlay mounted for this long. */
export const REVEAL_MS = 450;
const SCAN_MS = 1800;

const CREAM = "#f5ecd7";
const INK = "#3f3726";
const LINE = "rgba(63,55,38,0.10)";

// Scoped to sr-* names so nothing here can collide with the app-wide keyframes in index.css.
const STYLES = `
@keyframes sr-sweep { from { transform: translate3d(0, -100%, 0); } to { transform: translate3d(0, 0, 0); } }
@keyframes sr-dot { 0%, 72%, 100% { opacity: 0.18; } 34% { opacity: 1; } }
`;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** The bright 2px read-head, sitting on the bottom edge of whatever contains it. */
function ScanLine() {
  return (
    <span
      className="absolute inset-x-0 bottom-[-1px] block h-0.5"
      style={{
        background: "linear-gradient(90deg, rgba(251,191,36,0) 0%, #fde68a 14%, #f59e0b 50%, #fde68a 86%, rgba(251,191,36,0) 100%)",
        boxShadow: "0 0 14px 1px rgba(245,158,11,0.5)",
      }}
    />
  );
}

function Corners() {
  return (
    <>
      {(
        [
          ["top-3 left-3", "border-t-2 border-l-2"],
          ["top-3 right-3", "border-t-2 border-r-2"],
          ["bottom-3 left-3", "border-b-2 border-l-2"],
          ["bottom-3 right-3", "border-b-2 border-r-2"],
        ] as const
      ).map(([place, edge]) => (
        <span key={place} className={`absolute h-7 w-7 rounded-[4px] ${place} ${edge}`} style={{ borderColor: "rgba(63,55,38,0.30)" }} />
      ))}
    </>
  );
}

function Ellipsis({ reduced }: { reduced: boolean }) {
  if (reduced) return <span>…</span>;
  return (
    <span className="inline-flex w-3 justify-start">
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ animation: `sr-dot 1.25s ${i * 0.16}s ease-in-out infinite` }}>
          .
        </span>
      ))}
    </span>
  );
}

interface SketchRevealProps {
  /** data: URL of the capture this version came from. */
  src: string;
  /** Flips to true once the app underneath starts painting: the overlay retreats downward. */
  leaving: boolean;
  caption?: string;
}

export function SketchReveal({ src, leaving, caption = "Reading your sketch" }: SketchRevealProps) {
  const reduced = usePrefersReducedMotion();
  // Everything above the read-head is lifted a touch, as if it had already been taken in.
  const read = "linear-gradient(to bottom, rgba(255,250,235,0.05) 0%, rgba(255,250,235,0.13) 70%, rgba(251,191,36,0.14) 92%, rgba(245,158,11,0.34) 100%)";

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden="true">
      <style>{STYLES}</style>

      <div
        className="absolute inset-0"
        style={{
          backgroundColor: CREAM,
          clipPath: leaving ? "inset(100% 0 0 0)" : "inset(0 0 0 0)",
          opacity: leaving ? 0 : 1,
          transition: `clip-path ${REVEAL_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${REVEAL_MS}ms ease-in`,
          willChange: "clip-path",
        }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-contain p-6"
          style={{ filter: "saturate(0.5) sepia(0.1) contrast(1.06) drop-shadow(0 16px 28px rgba(63,55,38,0.28))" }}
        />

        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(${LINE} 1px, transparent 1px), linear-gradient(90deg, ${LINE} 1px, transparent 1px)`,
            backgroundSize: "46px 46px",
          }}
        />
        <Corners />

        {reduced ? (
          <div className="absolute inset-x-0 top-0 h-[62%]" style={{ background: read }}>
            <ScanLine />
          </div>
        ) : (
          <div
            className="absolute inset-x-0 top-0 h-full"
            style={{ animation: `sr-sweep ${SCAN_MS}ms linear infinite`, willChange: "transform" }}
          >
            <div className="absolute inset-0" style={{ background: read }} />
            <div
              className="absolute inset-x-0 top-full h-[9%]"
              style={{ background: "linear-gradient(to bottom, rgba(245,158,11,0.20), rgba(245,158,11,0))" }}
            />
            <ScanLine />
          </div>
        )}

        <div className="absolute inset-x-0 top-5 flex justify-center px-6">
          <span
            className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium tracking-wide"
            style={{ color: INK, backgroundColor: "rgba(255,253,247,0.72)", boxShadow: "inset 0 0 0 1px rgba(63,55,38,0.18)" }}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
              <circle cx="12" cy="12" r="2.75" />
            </svg>
            {caption}
            <Ellipsis reduced={reduced} />
          </span>
        </div>
      </div>

      {/* The read-head finishes its pass and takes the sketch with it. */}
      {!reduced && (
        <div
          className="absolute inset-x-0 h-0"
          style={{
            top: leaving ? "100%" : "0%",
            opacity: leaving ? 1 : 0,
            transition: `top ${REVEAL_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity 140ms ease`,
          }}
        >
          <ScanLine />
        </div>
      )}
    </div>
  );
}

interface CompareWipeProps {
  /** data: URL of the capture behind the version currently on screen. */
  src: string;
}

/** Sketch on the left of a draggable divider, running app on the right. Inert until switched on. */
export function CompareWipe({ src }: CompareWipeProps) {
  const stage = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const [held, setHeld] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pos, setPos] = useState(0.5);
  const active = pinned || held;

  const pinnedRef = useRef(pinned);
  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);

  // Hold V for a momentary 50/50 look. Synthetic keydowns forwarded out of the sandboxed app are
  // ignored: they never come with a matching keyup, so the hold could not be released.
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.code !== "KeyV" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || !e.isTrusted || typing(e.target)) return;
      if (!pinnedRef.current) setPos(0.5);
      setHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "KeyV") setHeld(false);
    };
    const release = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);

  const moveTo = useCallback((clientX: number) => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setPos(clamp01((clientX - rect.left) / rect.width));
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    moveTo(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging) moveTo(e.clientX);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };

  // Arrows only ever move the divider while the grab handle itself has focus; the app's own
  // left/right version stepping keeps working everywhere else.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    let next: number;
    if (e.key === "ArrowLeft") next = pos - step;
    else if (e.key === "ArrowRight") next = pos + step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setPinned(false);
      setHeld(false);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    setPos(clamp01(next));
  };

  return (
    <div ref={stage} className="pointer-events-none absolute inset-0 z-20">
      {active && (
        <>
          <div className="absolute inset-0 overflow-hidden" style={{ backgroundColor: CREAM, clipPath: `inset(0 ${(1 - pos) * 100}% 0 0)` }}>
            <img src={src} alt="The sketch this version was built from" draggable={false} className="absolute inset-0 h-full w-full object-contain p-6" />
            <span
              className="absolute top-3 left-3 rounded-md px-2 py-0.5 text-[0.65rem] font-semibold tracking-[0.18em] uppercase"
              style={{ color: INK, backgroundColor: "rgba(255,253,247,0.8)", boxShadow: "inset 0 0 0 1px rgba(63,55,38,0.18)" }}
            >
              Paper
            </span>
          </div>

          <div
            className="pointer-events-auto absolute inset-y-0 w-10 -translate-x-1/2 cursor-ew-resize touch-none"
            style={{ left: `${pos * 100}%` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span
              className="absolute inset-y-0 left-1/2 block w-0.5 -translate-x-1/2"
              style={{ backgroundColor: "#f5f0e6", boxShadow: "0 0 0 1px rgba(11,11,16,0.35), 0 0 16px rgba(245,240,230,0.45)" }}
            />
            <div
              role="slider"
              tabIndex={0}
              aria-label="Compare position between the sketch and the app"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pos * 100)}
              aria-valuetext={`${Math.round(pos * 100)} percent sketch`}
              onKeyDown={onKeyDown}
              className={`absolute top-1/2 left-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-paper text-ink shadow-lg shadow-black/40 ring-1 ring-ink/25 transition-transform duration-150 ${
                dragging ? "scale-110" : "hover:scale-105"
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.5 8.5 6 12l3.5 3.5M14.5 8.5 18 12l-3.5 3.5" />
              </svg>
            </div>
          </div>
        </>
      )}

      <button
        type="button"
        onClick={() => setPinned((on) => !on)}
        aria-pressed={pinned}
        title="Drag to compare with the sketch (hold V)"
        className={`pointer-events-auto absolute right-3 bottom-3 flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold ring-1 backdrop-blur transition duration-200 ${
          pinned ? "bg-paper text-ink ring-paper" : "bg-ink/65 text-white/70 ring-white/15 hover:bg-ink/85 hover:text-white"
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
          <path d="M12 5v14" />
          <path d="M3.5 5h8.5v14H3.5z" fill="currentColor" stroke="none" opacity="0.35" />
        </svg>
        Compare
      </button>
    </div>
  );
}
