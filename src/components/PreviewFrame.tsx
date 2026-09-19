import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PreviewFrameProps } from "../types";
import { CompareWipe, REVEAL_MS, SketchReveal } from "./SketchReveal";

// Loaded once per iframe. After its own load it re-opens the document and turns into a streaming sink:
// the parent posts chunks, the receiver document.write()s them, so the app renders while it is still arriving.
// Listeners are registered after document.open() because open() wipes the window's listeners; the storage
// shim is a plain global, which survives open(). The frame's origin is opaque, hence targetOrigin "*".
const RECEIVER = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
addEventListener("load", () => setTimeout(() => {
  const memoryStorage = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
      setItem: (k, v) => void m.set(String(k), String(v)),
      removeItem: (k) => void m.delete(String(k)),
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (_) {}
  }
  document.open();
  const tell = (msg) => parent.postMessage(msg, "*");
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data) return;
    if (e.data.t === "chunk") document.write(e.data.s);
    else if (e.data.t === "close") document.close();
  });
  // Nothing in the sandbox needs a real form navigation: it would reload the receiver and wipe the app's state.
  addEventListener("submit", (e) => e.preventDefault());
  // Shortcut keys pressed while the app has focus are handed to the parent, unless the app consumed them.
  const typing = (t) => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  const spaceOnButton = (e) => e.code === "Space" && !!e.target && e.target.tagName === "BUTTON";
  addEventListener("keydown", (e) => {
    if (typing(e.target)) return;
    // Arrows stay with the app: a generated game that forgets preventDefault would otherwise
    // step the filmstrip while it is being played. Every other shortcut is worth forwarding.
    if (e.key.startsWith("Arrow")) return;
    const onButton = spaceOnButton(e);
    if (onButton) e.preventDefault();
    const msg = { t: "key", key: e.key, code: e.code, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, repeat: e.repeat };
    setTimeout(() => { if (onButton || !e.defaultPrevented) tell(msg); }, 0);
  });
  addEventListener("keyup", (e) => { if (spaceOnButton(e)) e.preventDefault(); });
  addEventListener("error", (e) => tell({ t: "err", m: String(e.message || "Script error") }));
  addEventListener("unhandledrejection", (e) =>
    tell({ t: "err", m: "Unhandled promise rejection: " + String((e.reason && e.reason.message) || e.reason) }));
  tell({ t: "ready" });
}, 0), { once: true });
</script></body></html>`;

const FADE_MS = 300;
const FADE = `opacity ${FADE_MS}ms ease, filter ${FADE_MS}ms ease`;
const DIMMED: CSSProperties = { opacity: 0.35, filter: "blur(3px)", pointerEvents: "none" };
const HAND = '"Bradley Hand", "Segoe Print", "Chalkboard SE", "Comic Sans MS", cursive';

/** What the parent knows about one iframe's document. Lives in a ref, keyed by generationId. */
interface Channel {
  ready: boolean;
  written: number;
  bodySeen: boolean;
  closed: boolean;
  reported: Set<string>;
  /** Errors caught before close, with how much html had been written when they happened. */
  held: { message: string; at: number }[];
}

/** cur is the iframe being written; prev stays underneath, dimmed, until cur is revealed and the fade settles. */
interface Layers {
  cur: string | null;
  prev: string | null;
  revealed: boolean;
  settled: boolean;
}

const NO_LAYERS: Layers = { cur: null, prev: null, revealed: false, settled: false };

function advance(l: Layers, id: string | null): Layers {
  if (id === l.cur) return l;
  if (id === null) return NO_LAYERS;
  if (id === l.prev) return { cur: id, prev: null, revealed: true, settled: true };
  // An unrevealed cur was never visible: drop it and keep whatever is on screen as the underlay.
  return { cur: id, prev: l.revealed ? l.cur : l.prev, revealed: false, settled: false };
}

function report(ch: Channel, message: string, onRuntimeError: PreviewFrameProps["onRuntimeError"]) {
  if (ch.reported.has(message)) return;
  ch.reported.add(message);
  onRuntimeError?.(message);
}

export function PreviewFrame({ generationId, html, complete, sketchDataUrl, scanning, onRuntimeError }: PreviewFrameProps) {
  const [stored, setLayers] = useState<Layers>(() => advance(NO_LAYERS, generationId));
  const layers = advance(stored, generationId);
  if (layers !== stored) setLayers(layers);

  const root = useRef<HTMLDivElement>(null);
  const channels = useRef(new Map<string, Channel>());
  const latest = useRef({ generationId, html, complete, onRuntimeError });

  const pump = useCallback(() => {
    const { generationId: id, html, complete, onRuntimeError } = latest.current;
    if (!id) return;
    const ch = channels.current.get(id);
    const win = root.current?.querySelector<HTMLIFrameElement>(`iframe[data-gen="${CSS.escape(id)}"]`)?.contentWindow;
    if (!ch?.ready || !win) return;

    if (html.length > ch.written) {
      const from = ch.written;
      win.postMessage({ t: "chunk", s: html.slice(from) }, "*");
      ch.written = html.length;
      ch.bodySeen ||= /<body/i.test(html.slice(Math.max(0, from - 5)));
    }
    if (complete && !ch.closed) {
      win.postMessage({ t: "close" }, "*");
      ch.closed = true;
      // A script only runs once its </script> has been parsed, so it saw the same DOM it would see on a
      // normal load: every error held while streaming is real, and is surfaced once the document is done.
      for (const h of ch.held) report(ch, h.message, onRuntimeError);
      ch.held = [];
    }
    if (ch.bodySeen || (ch.closed && ch.written > 0)) {
      setLayers((l) => (l.cur === id && !l.revealed ? { ...l, revealed: true } : l));
    }
  }, []);

  useLayoutEffect(() => {
    latest.current = { generationId, html, complete, onRuntimeError };
    pump();
  });

  useLayoutEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!e.source) return;
      const frames = Array.from(root.current?.querySelectorAll("iframe") ?? []);
      const id = frames.find((f) => f.contentWindow === e.source)?.dataset.gen;
      const data = e.data as { t?: unknown; m?: unknown } | null;
      if (!id || id !== latest.current.generationId || typeof data !== "object" || !data) return;

      if (data.t === "key") {
        // Re-dispatched with target=window so the app-level shortcut listeners see it as their own.
        const k = data as Record<string, unknown>;
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: String(k.key ?? ""),
            code: String(k.code ?? ""),
            shiftKey: k.shiftKey === true,
            metaKey: k.metaKey === true,
            ctrlKey: k.ctrlKey === true,
            altKey: k.altKey === true,
            repeat: k.repeat === true,
            cancelable: true,
          }),
        );
      } else if (data.t === "ready") {
        // Also fires when the app reloads itself: start over and write the document again.
        const reported = channels.current.get(id)?.reported ?? new Set<string>();
        channels.current.set(id, { ready: true, written: 0, bodySeen: false, closed: false, reported, held: [] });
        pump();
      } else if (data.t === "err") {
        const ch = channels.current.get(id);
        const message = String(data.m).slice(0, 600);
        if (!ch || /ResizeObserver loop/i.test(message)) return;
        if (ch.closed) report(ch, message, latest.current.onRuntimeError);
        else ch.held.push({ message, at: ch.written });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pump]);

  // prev can come back as cur without remounting (and without a new `ready`), so its channel must survive.
  useEffect(() => {
    for (const id of channels.current.keys()) if (id !== layers.cur && id !== layers.prev) channels.current.delete(id);
  }, [layers.cur, layers.prev]);

  useEffect(() => {
    if (!layers.revealed || layers.settled) return;
    const timer = window.setTimeout(
      () => setLayers((l) => (l.revealed && !l.settled ? { ...l, prev: null, settled: true } : l)),
      FADE_MS + 40,
    );
    return () => window.clearTimeout(timer);
  }, [layers.cur, layers.revealed, layers.settled]);

  // Scan overlay. It owns the stage from "sent" until the document actually paints (bodySeen, which
  // is what flips layers.revealed), then wipes downward while staying mounted for the wipe.
  const painted = layers.cur !== null && layers.revealed;
  const wantScan = Boolean(scanning && sketchDataUrl) && !painted;
  const [scan, setScan] = useState<{ src: string; leaving: boolean } | null>(null);

  useEffect(() => {
    if (wantScan && sketchDataUrl) setScan({ src: sketchDataUrl, leaving: false });
    else setScan((s) => (s && !s.leaving ? { ...s, leaving: true } : s));
  }, [wantScan, sketchDataUrl]);

  const leaving = scan?.leaving === true;
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setScan(null), REVEAL_MS + 80);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const frames = [layers.prev, layers.cur].filter((id): id is string => id !== null);
  const showEmpty = layers.cur === null || (layers.prev === null && !layers.settled);
  const compareSrc = complete && painted && scan === null ? (sketchDataUrl ?? null) : null;

  return (
    <div ref={root} className="absolute inset-0 overflow-hidden rounded-[inherit] bg-white">
      {showEmpty && <EmptyState dimmed={layers.cur !== null} />}
      {frames.map((id) => {
        const isCur = id === layers.cur;
        const visible = isCur && layers.revealed;
        return (
          <iframe
            key={id}
            data-gen={id}
            title={isCur ? "Generated app preview" : "Previous version of the app"}
            aria-hidden={!isCur}
            tabIndex={isCur ? 0 : -1}
            sandbox="allow-scripts allow-forms allow-modals"
            srcDoc={RECEIVER}
            className="absolute inset-0 h-full w-full border-0"
            style={{
              background: "#fff",
              colorScheme: "light",
              transition: FADE,
              ...(isCur ? { opacity: visible ? 1 : 0, pointerEvents: visible ? "auto" : "none" } : DIMMED),
            }}
          />
        );
      })}
      {scan && <SketchReveal src={scan.src} leaving={scan.leaving} />}
      {compareSrc && <CompareWipe src={compareSrc} />}
    </div>
  );
}

function EmptyState({ dimmed }: { dimmed: boolean }) {
  return (
    <div
      className="absolute inset-0 grid place-items-center p-6 text-[#3f3726]"
      style={{
        backgroundColor: "#f5ecd7",
        backgroundImage: "radial-gradient(rgba(63,55,38,0.22) 1px, transparent 1.5px)",
        backgroundSize: "22px 22px",
        transition: FADE,
        ...(dimmed ? DIMMED : null),
      }}
    >
      <div className="flex max-w-xl -rotate-1 flex-col items-center gap-5 rounded-3xl border-2 border-dashed border-[#3f3726]/45 bg-[#fffaf0]/70 px-10 py-12 text-center shadow-[0_24px_48px_-28px_rgba(63,55,38,0.55)]">
        <svg viewBox="0 0 120 96" className="h-24 w-32" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <g transform="rotate(-4 60 48)" stroke="#3f3726" strokeWidth="2.5">
            <rect x="22" y="8" width="76" height="80" rx="5" fill="#fffdf7" />
            <path d="M32 22h34M32 34h22" />
            <rect x="32" y="46" width="56" height="30" rx="3" />
            <path d="M38 69l11-11 9 7 10-13 14 12" strokeWidth="2" />
          </g>
          <g stroke="#e0402b" strokeWidth="2.5">
            <path d="M24 60c-3-14 14-25 40-24s38 12 34 27-24 22-44 20-27-10-30-23z" />
            <path d="M104 30l10-12m0 0l-9 1m9-1l-1 9" />
          </g>
        </svg>
        <p className="text-[clamp(1.5rem,2.4vw,2.4rem)] leading-tight font-semibold text-balance" style={{ fontFamily: HAND }}>
          Hold a sketch up to the camera and press{" "}
          <kbd className="inline-block rounded-lg border-2 border-b-4 border-[#3f3726]/70 bg-[#fffdf7] px-3 align-middle font-mono text-[0.6em] font-bold tracking-wide">
            Space
          </kbd>
        </p>
        <p className="text-sm text-[#3f3726]/70">
          Then mark it up with a <span className="font-semibold text-[#e0402b]">red pen</span>, hold it up again, and watch the app change.
        </p>
      </div>
    </div>
  );
}
