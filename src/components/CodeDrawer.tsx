import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface CodeDrawerProps {
  open: boolean;
  html: string;
  /** True while the HTML is still streaming in. */
  live: boolean;
  onClose: () => void;
}

const TOKEN = /(<!--.*?-->)|(<\/?[A-Za-z][\w-]*|\/?>)|("[^"\n]*"|'[^'\n]*')|([\w:@.-]+)(?==["'])/g;
const TOKEN_CLASS = ["text-white/30 italic", "text-glow", "text-paper/90", "text-sky-300/80"];

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const kind = match[1] ? 0 : match[2] ? 1 : match[3] ? 2 : 3;
    out.push(
      <span key={at} className={TOKEN_CLASS[kind]}>
        {match[0]}
      </span>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const Line = memo(function Line({ n, text, caret }: { n: number; text: string; caret: boolean }) {
  return (
    <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3">
      <span className="text-right text-white/20 tabular-nums select-none">{n}</span>
      <span className="[overflow-wrap:anywhere] whitespace-pre-wrap text-white/70">
        {highlight(text)}
        {caret && <span className="ml-px inline-block h-[1.05em] w-[0.55em] translate-y-[0.2em] animate-blink bg-glow" />}
      </span>
    </div>
  );
});

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

export function CodeDrawer({ open, html, live, onClose }: CodeDrawerProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [rendered, setRendered] = useState(open);

  useEffect(() => {
    if (open) {
      setRendered(true);
      stickRef.current = true;
      return;
    }
    const timer = window.setTimeout(() => setRendered(false), 320);
    return () => window.clearTimeout(timer);
  }, [open]);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (pane && rendered && live && stickRef.current) pane.scrollTop = pane.scrollHeight;
  }, [html, rendered, live]);

  const lines = rendered ? html.split("\n") : [];

  return (
    <aside
      aria-hidden={!open}
      className={`absolute inset-y-0 right-0 z-30 flex w-[min(48%,42rem)] min-w-[22rem] flex-col border-l border-white/10 bg-ink/90 shadow-[-24px_0_60px_-20px_rgba(0,0,0,0.7)] backdrop-blur-xl transition duration-300 ease-out ${
        open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-full opacity-0"
      }`}
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-white/10 px-4">
        <span className="font-mono text-sm font-semibold text-glow">&lt;/&gt;</span>
        <span className="text-sm font-medium text-white/80">Source</span>
        {live && (
          <span className="flex items-center gap-1.5 text-[0.65rem] font-semibold tracking-[0.18em] text-paper uppercase">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-paper" />
            streaming
          </span>
        )}
        <span className="ml-auto font-mono text-xs text-white/50 tabular-nums">
          {html.length.toLocaleString("en-US")} chars · ~{compact(html.length / 4)} tok
        </span>
        <button
          type="button"
          onClick={onClose}
          tabIndex={open ? 0 : -1}
          aria-label="Close source drawer"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div
        ref={paneRef}
        onScroll={(e) => {
          const pane = e.currentTarget;
          stickRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
        }}
        className="thin-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-3 pr-4 font-mono text-[0.78rem] leading-[1.55]"
      >
        {html.length === 0 ? (
          <p className="px-4 text-white/35">{live ? "Waiting for the first bytes…" : "Nothing built yet."}</p>
        ) : (
          lines.map((text, index) => (
            <Line key={index} n={index + 1} text={text} caret={live && index === lines.length - 1} />
          ))
        )}
      </div>
    </aside>
  );
}
