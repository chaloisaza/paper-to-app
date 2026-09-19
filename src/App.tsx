import { memo, useCallback, useEffect, useInsertionEffect, useMemo, useRef, useState } from "react";
import type { BudgetState, Effort, GenerateRequest, HealthResponse, SamplesResponse, Version } from "../shared/protocol";
import type { CapturedFrame, GenerationMeta, GenerationStatus } from "./types";
import { CameraCapture } from "./components/CameraCapture";
import { PreviewFrame } from "./components/PreviewFrame";
import { StatusPill } from "./components/StatusPill";
import { ThinkingTicker } from "./components/ThinkingTicker";
import { Filmstrip } from "./components/Filmstrip";
import type { PendingCard } from "./components/Filmstrip";
import { CodeDrawer } from "./components/CodeDrawer";
import { SourcePicker } from "./components/SourcePicker";
import { useGeneration } from "./hooks/useGeneration";
import { fileToFrame, urlToFrame } from "./lib/frame";
import { downloadHtml, exportHtml } from "./lib/htmlStream";

interface RunContext {
  request: GenerateRequest;
  imageDataUrl: string | null;
  imageBase64: string | null;
}

type RunSource = Pick<RunContext, "imageDataUrl" | "imageBase64">;

interface Failure {
  message: string;
  retry: boolean;
}

const Camera = memo(CameraCapture);

// Unattended mode is opt-in through the URL only - no keyboard shortcut, so a stray keypress during
// the rehearsed demo can never switch the app into behaving differently than it did in rehearsal.
const params = new URLSearchParams(window.location.search);
const KIOSK = params.has("kiosk");
const DEBUG = params.has("debug");
const KIOSK_RESET_MS = 90_000; // idle this long and the next visitor starts from a clean slate
const KIOSK_TOAST_MS = 6_000;
const KIOSK_FAILURE = "That one didn't come out. Hold your sketch up again.";

const EFFORTS: ReadonlyArray<{ value: Effort; label: string }> = [
  { value: "low", label: "Fast" },
  { value: "medium", label: "Balanced" },
  { value: "high", label: "Quality" },
];

const STEPS: ReadonlyArray<readonly [string, string]> = [
  ["Sketch it", "Boxes, labels, arrows. Messy is fine."],
  ["Hold it up", "Fit the page in the frame and press Space."],
  ["Red-pen it", "Circle, cross out, write a note. Hold it up again."],
];

const isLiveStatus = (status: GenerationStatus) => status === "connecting" || status === "thinking" || status === "streaming";
const hasDocument = (html: string) => /<\/html>|<body/i.test(html);

function prettyModel(id: string): string {
  const parts = id.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-").filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (/^\d+$/.test(part) && last !== undefined && /^[\d.]+$/.test(last)) out[out.length - 1] = `${last}.${part}`;
    else out.push(/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1));
  }
  return out.join(" ");
}

function titleSlug(html: string): string | null {
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(html.slice(0, 6000))?.[1] ?? "";
  const slug = title
    .toLowerCase()
    .replace(/&[a-z#0-9]+;/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/-+$/, "");
  return slug || null;
}

function failureReason(status: GenerationStatus, meta: GenerationMeta | null, error: { message: string } | null): string {
  if (status === "error") return error?.message || "The run failed before it finished.";
  switch (meta?.stopReason) {
    case "end_turn":
      return "Claude replied, but there was no complete app in the answer.";
    case "max_tokens":
      return "The app was cut off at the token limit before it finished.";
    case "refusal":
      return "Claude declined this one. Try a different sketch or note.";
    default:
      return `The run stopped early (${meta?.stopReason ?? "no stop reason"}).`;
  }
}

// Keys typed after playing with the generated app would land in its iframe (the receiver forwards shortcuts, but
// native focus is still better); hand focus back once the pointer leaves it, a version commits, or one is selected.
function releaseFrameFocus() {
  const el = document.activeElement;
  if (!(el instanceof HTMLIFrameElement)) return;
  el.blur();
  window.focus();
}

function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  // Insertion effects run before any child layout effect, so PreviewFrame never calls a stale handler.
  useInsertionEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

function PencilGlyph({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20l1.1-4.4L16.4 4.3a2 2 0 0 1 2.8 0l.5.5a2 2 0 0 1 0 2.8L8.4 18.9z" />
      <path d="M14.3 6.4l3.3 3.3" />
      <path d="M4 20l2.6-.7" />
    </svg>
  );
}

function EffortToggle({ value, disabled, onChange }: { value: Effort; disabled: boolean; onChange: (effort: Effort) => void }) {
  const index = EFFORTS.findIndex((option) => option.value === value);
  return (
    <div
      role="radiogroup"
      aria-label="Effort"
      className={`relative grid h-9 grid-cols-3 rounded-full bg-white/5 p-1 ring-1 ring-white/10 transition-opacity duration-200 ${disabled ? "opacity-50" : ""}`}
    >
      <span
        className="absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] rounded-full bg-paper shadow-md shadow-black/40 transition-transform duration-200 ease-out"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {EFFORTS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`relative z-10 rounded-full px-4 text-sm font-medium transition-colors duration-200 ${
            option.value === value ? "text-ink" : "text-white/55 enabled:hover:text-white"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function BudgetChip({ budget }: { budget: BudgetState | undefined }) {
  if (!budget || budget.capUsd === null) return null;
  const left = Math.max(0, budget.capUsd - budget.spentUsd);
  const share = budget.capUsd > 0 ? left / budget.capUsd : 0;
  const tone = !budget.canAfford ? "text-redpen" : share < 0.2 ? "text-ember" : "text-white/50";
  return (
    <span
      title={`${budget.runs} run${budget.runs === 1 ? "" : "s"} · $${budget.spentUsd.toFixed(2)} of $${budget.capUsd.toFixed(2)} spent`}
      className={`font-mono text-[11px] tabular-nums ${tone}`}
    >
      ${left.toFixed(2)} left
    </span>
  );
}

function HealthDot({ health, down }: { health: HealthResponse | null; down: boolean }) {
  const bad = down || (health !== null && !health.ok);
  const tone = bad ? "bg-redpen" : !health ? "bg-white/30" : health.hasKey ? "bg-emerald-400" : "bg-ember";
  const label = bad ? "Offline" : !health ? "Checking" : health.hasKey ? "Live" : "Replay only";
  const detail = bad
    ? "The local server is not answering on /api"
    : health
      ? `${health.model}${health.fastMode ? " · fast mode" : ""}${health.recording ? " · recording runs" : ""}`
      : "Checking the local server";
  return (
    <div title={detail} className="flex items-center gap-2 text-xs text-white/60">
      {health?.recording && !bad && (
        <span className="flex items-center gap-1.5 rounded-full bg-redpen/15 px-2 py-0.5 text-[0.65rem] font-semibold tracking-wider text-redpen">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-redpen" />
          REC
        </span>
      )}
      <span className="relative flex h-2.5 w-2.5">
        {!bad && health?.hasKey && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/50 [animation-duration:2.4s]" />}
        <span className={`relative h-2.5 w-2.5 rounded-full transition-colors duration-300 ${tone}`} />
      </span>
      {label}
    </div>
  );
}

function Toast({
  tone,
  message,
  actionLabel,
  onAction,
  onDismiss,
}: {
  tone: "error" | "warn";
  message: string;
  actionLabel: string | null;
  onAction: () => void;
  onDismiss: () => void;
}) {
  const accent = tone === "error" ? "bg-redpen" : "bg-ember";
  return (
    <div
      role="alert"
      className="absolute top-4 left-1/2 z-40 flex w-max max-w-[min(92%,46rem)] -translate-x-1/2 animate-drop items-center gap-3 rounded-2xl bg-ink/85 py-2.5 pr-2.5 pl-4 shadow-2xl shadow-black/60 ring-1 ring-white/15 backdrop-blur-xl"
    >
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${accent}`} />
      <p className="line-clamp-2 min-w-0 text-[0.95rem] leading-6 text-white/90">{message}</p>
      {actionLabel && (
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 rounded-xl bg-paper px-3.5 py-1.5 text-sm font-semibold text-ink transition duration-200 hover:bg-white active:scale-[0.98]"
        >
          {actionLabel}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-white/45 transition duration-200 hover:bg-white/10 hover:text-white"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

function ReplayMenu({ recordings, onPick, onClose }: { recordings: string[]; onPick: (name: string) => void; onClose: () => void }) {
  return (
    <div className="absolute top-full right-5 z-50 mt-1 w-72 animate-drop overflow-hidden rounded-2xl bg-panel/95 shadow-2xl shadow-black/70 ring-1 ring-white/15 backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="text-[0.65rem] font-semibold tracking-[0.2em] text-ember uppercase">Replay a recording</span>
        <button type="button" onClick={onClose} className="text-xs text-white/40 transition hover:text-white">
          Esc
        </button>
      </div>
      {recordings.length === 0 ? (
        <p className="px-4 py-4 text-sm text-white/50">No recordings on the server yet.</p>
      ) : (
        <ul className="thin-scrollbar max-h-72 overflow-y-auto p-1.5">
          {recordings.map((name, index) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => onPick(name)}
                className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm text-white/85 transition duration-150 hover:bg-white/10"
              >
                <kbd className="w-6 shrink-0 rounded-md bg-white/5 py-0.5 text-center font-mono text-[0.65rem] text-white/60 ring-1 ring-white/10">
                  {index < 9 ? index + 1 : "·"}
                </kbd>
                <span className="truncate">{name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Superseded by the scan overlay PreviewFrame now owns (see `sketchDataUrl` / `scanning` below).
// Kept as a one-line escape hatch: render `{scanSrc && <ScanOverlay src={scanSrc} visible={scanning} />}`
// back inside the preview stage if that overlay ever has to come out again.
function ScanOverlay({ src, visible }: { src: string; visible: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-ink/80 pb-16 backdrop-blur-md transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="relative -rotate-2 animate-pop overflow-hidden rounded-xl shadow-[0_30px_80px_-20px] shadow-glow/50 ring-1 ring-white/20">
        <img src={src} alt="" draggable={false} className="block max-h-[52vh] max-w-[46vw]" />
        <div className="absolute inset-x-0 h-[16%] animate-scan border-b border-glow/80 bg-linear-to-b from-transparent to-glow/35" />
        <div className="absolute inset-0 bg-linear-to-tr from-glow/10 via-transparent to-paper/10" />
      </div>
    </div>
  );
}

export function App() {
  const gen = useGeneration();
  const [versions, setVersions] = useState<Version[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [note, setNote] = useState("");
  const [effort, setEffort] = useState<Effort>("low");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [samples, setSamples] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [pending, setPending] = useState<RunContext | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [runtimeError, setRuntimeError] = useState<{ id: string; message: string } | null>(null);
  const [redInk, setRedInk] = useState(false);

  const lastRun = useRef<RunContext | null>(null);
  const settledId = useRef<string | null>(null);
  const mutedErrors = useRef(new Set<string>());
  const autoFixed = useRef(new Set<string>());

  const assetOrigin = window.location.origin;
  const base = versions[currentIndex] ?? null;
  // A version that came out of a recording (a stand-in for a run we couldn't afford) is not
  // something to red-pen: in kiosk mode the next capture starts a new app instead.
  const kioskBase = KIOSK && base?.replay ? null : base;
  const runId = gen.generationId;
  const live = isLiveStatus(gen.status);
  // True for the single render between the stream finishing and the commit effect: keeps the live iframe mounted.
  const awaitingCommit =
    gen.status === "done" &&
    runId !== null &&
    gen.meta?.stopReason === "end_turn" &&
    !versions.some((version) => version.id === runId) &&
    hasDocument(gen.html);

  const showRun = live || awaitingCommit;
  const frameId = showRun ? runId : (base?.id ?? null);
  const frameHtml = showRun ? gen.html : (base?.html ?? "");
  const bodySeen = useMemo(() => /<body/i.test(gen.html), [gen.html]);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) throw new Error(`health ${res.status}`);
        const data = (await res.json()) as HealthResponse;
        if (cancelled) return;
        setHealth(data);
        setServerDown(false);
      } catch {
        if (!cancelled) setServerDown(true);
      }
    };
    void check();
    const timer = window.setInterval(check, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const serverUp = health !== null && !serverDown;
  useEffect(() => {
    if (!serverUp) return;
    let cancelled = false;
    fetch("/api/samples")
      .then((res) => (res.ok ? (res.json() as Promise<SamplesResponse>) : { samples: [] }))
      .then((data) => {
        if (!cancelled) setSamples(Array.isArray(data.samples) ? data.samples : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [serverUp]);

  // A mouse click leaves focus on the button; Space would then press it again while also firing a capture.
  useEffect(() => {
    const release = (e: MouseEvent) => {
      const el = document.activeElement;
      if (e.detail > 0 && el instanceof HTMLButtonElement) el.blur();
    };
    window.addEventListener("click", release);
    return () => window.removeEventListener("click", release);
  }, []);

  const run = (request: GenerateRequest, source: RunSource) => {
    const context: RunContext = { request: KIOSK ? { ...request, kiosk: true } : request, ...source };
    lastRun.current = context;
    setPending(context);
    setFailure(null);
    setReplayOpen(false);
    gen.start(context.request).catch((err: unknown) => {
      setPending(null);
      setFailure({ message: err instanceof Error ? err.message : "The run failed before it started.", retry: true });
    });
  };

  const handleFrame = useEvent((frame: CapturedFrame) => {
    if (live) return;
    const instruction = note.trim() || undefined;
    // In kiosk mode the app on screen may be a recording that stood in for a run we couldn't
    // afford. Iterating against someone else's app would be nonsense, so start fresh instead.
    const base = kioskBase;
    const request: GenerateRequest = base
      ? {
          mode: "iterate",
          image: frame.base64,
          prevImage: base.imageBase64 ?? undefined,
          currentHtml: base.html,
          instruction,
          effort,
          assetOrigin,
        }
      : { mode: "create", image: frame.base64, instruction, effort, assetOrigin };
    run(request, { imageDataUrl: frame.dataUrl, imageBase64: frame.base64 });
  });

  const loadFrame = (loading: Promise<CapturedFrame>) => {
    loading.then(handleFrame).catch((err: unknown) => {
      setFailure({ message: err instanceof Error ? err.message : "That image could not be read.", retry: false });
    });
  };
  const handleFile = useEvent((file: File) => loadFrame(fileToFrame(file)));
  const handleSample = useEvent((url: string) => loadFrame(urlToFrame(url)));
  // The live red-ink verdict only tints the capture button; it never changes what a capture does.
  const handleRedInk = useEvent((present: boolean) => setRedInk(present));

  // Text-only edit: re-sends the capture already on file together with the typed note.
  const applyNote = () => {
    if (live || !base?.imageBase64 || !note.trim()) return;
    run(
      { mode: "iterate", image: base.imageBase64, currentHtml: base.html, instruction: note.trim(), effort, assetOrigin },
      { imageDataUrl: base.imageDataUrl, imageBase64: base.imageBase64 },
    );
  };

  const retry = () => {
    const context = lastRun.current;
    if (context && !live) run(context.request, context);
  };

  const startReplay = (name: string) => {
    if (live) return;
    run({ mode: "create", replay: name, effort, assetOrigin }, { imageDataUrl: null, imageBase64: null });
  };

  const stop = () => {
    if (!live) return;
    gen.abort();
    setPending(null);
    setFailure({ message: "Stopped. The last good version is still on screen.", retry: true });
  };

  useEffect(() => {
    if (!runId || settledId.current === runId) return;
    if (gen.status !== "done" && gen.status !== "error") return;
    settledId.current = runId;
    setPending(null);
    const context = lastRun.current;
    if (!context) return;
    const meta = gen.meta;
    if (gen.status === "done" && meta && meta.stopReason === "end_turn" && hasDocument(gen.html)) {
      const version: Version = {
        id: runId,
        imageDataUrl: context.imageDataUrl,
        imageBase64: context.imageBase64,
        html: gen.html,
        mode: context.request.mode,
        ms: meta.ms,
        usage: meta.usage,
        model: meta.model,
        replay: meta.replay || Boolean(context.request.replay),
      };
      setVersions((list) => [...list, version]);
      setCurrentIndex(versions.length);
      // Only the note this run consumed is cleared; anything typed during the run is the next instruction.
      setNote((n) => (n.trim() === (context.request.instruction ?? "") ? "" : n));
      setFailure(null);
      releaseFrameFocus();
    } else {
      setFailure({ message: KIOSK ? KIOSK_FAILURE : failureReason(gen.status, meta, gen.error), retry: true });
    }
  }, [gen.status, gen.meta, gen.html, gen.error, runId, versions.length]);

  const handleRuntimeError = useEvent((message: string) => {
    if (!frameId || mutedErrors.current.has(frameId)) return;
    const id = frameId;
    setRuntimeError((prev) => (prev?.id === id ? prev : { id, message }));
  });

  const thrown = !live && base && runtimeError?.id === base.id ? runtimeError.message : null;

  const dismissThrown = () => {
    if (base) mutedErrors.current.add(base.id);
    setRuntimeError(null);
  };

  const fixIt = () => {
    if (live || !base || !thrown) return;
    run(
      { mode: "fix", currentHtml: base.html, runtimeError: thrown, effort, assetOrigin },
      { imageDataUrl: base.imageDataUrl, imageBase64: base.imageBase64 },
    );
  };

  // Kiosk autopilot. Nobody is standing there to press "Fix it", clear the screen between
  // visitors, or dismiss a toast, so each of those happens on a timer instead.
  useEffect(() => {
    if (!KIOSK || live || !base || !thrown || autoFixed.current.has(base.id)) return;
    autoFixed.current.add(base.id);
    fixIt();
  }, [live, base, thrown, fixIt]);

  useEffect(() => {
    if (!KIOSK || live || currentIndex === -1) return;
    const timer = window.setTimeout(() => setCurrentIndex(-1), KIOSK_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [live, currentIndex]);

  useEffect(() => {
    if (!KIOSK || !failure) return;
    const timer = window.setTimeout(() => setFailure(null), KIOSK_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [failure]);

  const select = useEvent((index: number) => {
    if (live || index < 0 || index >= versions.length) return;
    mutedErrors.current.delete(versions[index].id);
    setCurrentIndex(index);
    setFailure(null);
    releaseFrameFocus();
  });

  const step = (delta: number) => {
    if (versions.length === 0) return;
    if (currentIndex === -1) {
      if (delta < 0) select(versions.length - 1);
      return;
    }
    select(Math.min(versions.length - 1, Math.max(0, currentIndex + delta)));
  };

  const newApp = () => {
    if (live) return;
    setCurrentIndex(-1);
    setFailure(null);
  };

  const download = () => {
    if (base) downloadHtml(exportHtml(base.html, assetOrigin), `paper-to-app-v${currentIndex + 1}.html`);
  };

  const recordings = health?.recordings ?? [];

  const onKey = useEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.repeat && !e.key.startsWith("Arrow"))) return;
    const target = e.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
      if (e.key === "Escape") target.blur();
      return;
    }
    if (e.code === "KeyR" && e.shiftKey) {
      e.preventDefault();
      if (!live) setReplayOpen((open) => !open);
      return;
    }
    if (replayOpen && /^[1-9]$/.test(e.key)) {
      const name = recordings[Number(e.key) - 1];
      if (name) startReplay(name);
      return;
    }
    switch (e.key.toLowerCase()) {
      case "arrowleft":
        e.preventDefault();
        step(-1);
        break;
      case "arrowright":
        e.preventDefault();
        step(1);
        break;
      case "c":
        setDrawerOpen((open) => !open);
        break;
      case "d":
        download();
        break;
      case "n":
        newApp();
        break;
      case "escape":
        if (live) stop();
        else if (replayOpen) setReplayOpen(false);
        else if (failure) setFailure(null);
        else if (thrown) dismissThrown();
        else if (drawerOpen) setDrawerOpen(false);
        break;
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const modelId = gen.meta?.model || health?.model || "";
  const modelName = modelId ? prettyModel(modelId) : null;
  const speaker = modelName ?? "Fable 5.1";
  const runMode = pending?.request.mode ?? "create";
  const replaying = live ? Boolean(pending?.request.replay) : Boolean(gen.meta?.replay);
  const connectingLabel = pending?.request.replay
    ? "Loading the recording…"
    : runMode === "fix"
      ? "Sending the error…"
      : runMode === "iterate"
        ? "Sending red-pen edits…"
        : "Sending sketch…";
  const thinkingLabel =
    runMode === "fix"
      ? `${speaker} is tracking down the error…`
      : runMode === "iterate"
        ? `${speaker} is reading your red-pen edits…`
        : `${speaker} is reading your sketch…`;

  const pillStatus: GenerationStatus = gen.status === "done" && !base && !awaitingCommit ? "idle" : gen.status;

  const pendingImage = pending?.imageDataUrl ?? null;
  const pendingCard = useMemo<PendingCard | null>(
    () => (live ? { imageDataUrl: pendingImage, label: "building…" } : null),
    [live, pendingImage],
  );

  const slug = titleSlug(frameHtml) ?? (live ? "building" : base ? "untitled-app" : "new-app");
  const versionLabel = live ? `v${versions.length + 1}` : base ? `v${currentIndex + 1}` : null;
  // A fix run has no fresh paper behind it, so it scans over nothing rather than over a stale capture.
  const scanSrc = pending && pending.request.mode !== "fix" ? pending.imageDataUrl : null;
  // While a run owns the stage the sketch is the capture that started it; otherwise it is the shown version's.
  const sketchDataUrl = showRun ? scanSrc : (base?.imageDataUrl ?? null);
  // "Sent" until the first markup that can paint: start() flips the status in the same tick as setPending.
  const scanning = live && !bodySeen;
  const canApplyNote = !live && Boolean(base?.imageBase64) && note.trim().length > 0;
  const redPenCue = redInk && !live && base !== null;

  return (
    <div className="flex h-full flex-col">
      {serverDown ? (
        <div className="flex h-8 shrink-0 animate-drop items-center justify-center border-b border-redpen/25 bg-redpen/10 text-sm font-medium text-redpen">
          Can't reach the local server — start it with pnpm dev
        </div>
      ) : health && !health.hasKey ? (
        <div className="flex h-8 shrink-0 animate-drop items-center justify-center border-b border-ember/25 bg-ember/10 text-sm font-medium text-ember">
          No API key on the server — replay mode only (Shift+R)
        </div>
      ) : (
        health &&
        !health.budget.canAfford && (
          <div className="flex h-8 shrink-0 animate-drop items-center justify-center border-b border-ember/25 bg-ember/10 text-sm font-medium text-ember">
            Spending cap reached — ${health.budget.spentUsd.toFixed(2)} of ${health.budget.capUsd?.toFixed(2)} used.{" "}
            {KIOSK ? "Showing saved runs instead." : "Press Shift+R to replay a saved run."}
          </div>
        )
      )}

      <header className="relative z-40 grid h-14 shrink-0 grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-4 px-5">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-linear-to-br from-paper to-[#d9d0bd] text-ink shadow-lg shadow-black/40 ring-1 ring-white/20">
            <PencilGlyph className="h-5 w-5" />
          </span>
          <h1 className="flex items-baseline text-[1.35rem] leading-none tracking-tight">
            <span className="font-serif text-paper italic">Paper</span>
            <span className="mx-1 font-semibold text-redpen">→</span>
            <span className="font-semibold text-white">App</span>
          </h1>
        </div>

        <div className="min-w-0 max-w-[40rem] justify-self-center">
          <StatusPill
            status={pillStatus}
            elapsedMs={gen.elapsedMs}
            outputChars={gen.outputChars}
            meta={gen.meta}
            error={gen.error?.message ?? null}
            modelName={modelName}
            replay={replaying}
            connectingLabel={connectingLabel}
            thinkingLabel={thinkingLabel}
          />
        </div>

        <div className="flex items-center justify-end gap-4">
          <EffortToggle value={effort} disabled={live} onChange={setEffort} />
          <BudgetChip budget={health?.budget} />
          <HealthDot health={health} down={serverDown} />
        </div>

        {replayOpen && <ReplayMenu recordings={recordings} onPick={startReplay} onClose={() => setReplayOpen(false)} />}
      </header>

      <main className="flex min-h-0 flex-1 gap-5 px-5 pt-1 pb-4">
        <section className="no-scrollbar flex w-[35%] min-w-0 shrink-0 flex-col gap-3 overflow-y-auto">
          <div className={redPenCue ? "redpen-cue" : undefined}>
            <Camera
              disabled={live}
              captureLabel={base ? "Apply red-pen edits" : "Capture sketch"}
              onCapture={handleFrame}
              onRedInk={handleRedInk}
              auto={KIOSK}
              debug={DEBUG}
            />
          </div>

          <label className="flex h-11 shrink-0 items-center gap-3 rounded-xl bg-white/5 px-4 ring-1 ring-white/10 transition duration-200 focus-within:bg-white/10 focus-within:ring-paper/50">
            <PencilGlyph className="h-4 w-4 shrink-0 text-white/40" />
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                e.currentTarget.blur();
                applyNote();
              }}
              placeholder="Typed note (optional)"
              aria-label="Typed note (optional)"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/45"
            />
            {canApplyNote && (
              <span className="flex shrink-0 animate-fade items-center gap-1.5 text-xs text-white/55">
                <kbd className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[0.65rem] text-white/70 ring-1 ring-white/10">Enter</kbd>
                applies it now
              </span>
            )}
          </label>

          <div className="flex shrink-0 items-center gap-3">
            <SourcePicker samples={samples} disabled={live} onFile={handleFile} onSample={handleSample} />
            <button
              type="button"
              disabled={live || !base}
              onClick={newApp}
              title="Start over with a blank page (N)"
              className="flex h-11 shrink-0 items-center gap-2 rounded-xl bg-white/5 px-4 text-sm font-medium text-white/85 ring-1 ring-white/10 transition duration-200 enabled:hover:bg-white/10 enabled:hover:ring-white/20 disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New app
            </button>
          </div>

          <ol className="hidden min-h-0 flex-1 flex-col justify-center gap-4 rounded-2xl bg-white/[0.03] px-6 py-5 ring-1 ring-white/5 [@media(min-height:900px)]:flex">
            {STEPS.map(([title, body], index) => (
              <li key={title} className="flex items-start gap-4">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-serif text-base italic ring-1 ${
                    index === 2 ? "bg-redpen/15 text-redpen ring-redpen/30" : "bg-paper/10 text-paper ring-paper/20"
                  }`}
                >
                  {index + 1}
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold text-white/90">{title}</span>
                  <span className="text-sm leading-snug text-white/60">{body}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="relative min-w-0 flex-1" onPointerLeave={releaseFrameFocus}>
          <div className={`pointer-events-none absolute -inset-2 transition-opacity duration-500 ${live ? "opacity-100" : "opacity-0"}`}>
            <div className="h-full w-full animate-breathe rounded-[1.75rem] bg-glow/25 blur-2xl" />
          </div>

          <div
            className={`relative flex h-full flex-col overflow-hidden rounded-2xl bg-panel shadow-2xl shadow-black/60 ring-1 transition duration-300 ${
              live ? "ring-glow/45" : "ring-white/10"
            }`}
          >
            <div className="flex h-11 shrink-0 items-center gap-4 border-b border-white/5 bg-raised/70 px-4">
              <div className="flex shrink-0 items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-[#ff5f57]/85" />
                <span className="h-3 w-3 rounded-full bg-[#febc2e]/85" />
                <span className="h-3 w-3 rounded-full bg-[#28c840]/85" />
              </div>
              <div className="mx-auto flex h-7 w-full max-w-xl min-w-0 items-center gap-2 rounded-lg bg-ink/60 px-3 font-mono text-xs ring-1 ring-white/5">
                <PencilGlyph className="h-3.5 w-3.5 shrink-0 text-paper/60" />
                <span className="truncate">
                  <span className="text-white/45">paper://</span>
                  <span className={live ? "shimmer-text" : "text-white/80"}>{slug}</span>
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {versionLabel && (
                  <span
                    className={`mr-1 rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 transition-colors duration-300 ${
                      live ? "bg-glow/15 text-glow ring-glow/30" : "bg-paper/10 text-paper ring-paper/20"
                    }`}
                  >
                    {versionLabel}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setDrawerOpen((open) => !open)}
                  aria-pressed={drawerOpen}
                  title="Show the source (C)"
                  className={`flex h-7 items-center rounded-lg px-2.5 font-mono text-xs font-semibold transition duration-200 ${
                    drawerOpen ? "bg-glow/20 text-glow ring-1 ring-glow/40" : "text-white/55 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  &lt;/&gt;
                </button>
                <button
                  type="button"
                  onClick={download}
                  disabled={!base || live}
                  title="Download this version as one HTML file (D)"
                  aria-label="Download this version"
                  className="flex h-7 w-8 items-center justify-center rounded-lg text-white/55 transition duration-200 enabled:hover:bg-white/10 enabled:hover:text-white disabled:opacity-30"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="relative min-h-0 flex-1 overflow-hidden">
              <PreviewFrame
                generationId={frameId}
                html={frameHtml}
                complete={!live}
                sketchDataUrl={sketchDataUrl}
                scanning={scanning}
                onRuntimeError={handleRuntimeError}
              />

              <div
                className={`pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden transition-opacity duration-300 ${
                  live ? "opacity-100" : "opacity-0"
                }`}
              >
                <div className="h-full w-1/3 animate-sweep bg-linear-to-r from-transparent via-glow to-transparent" />
              </div>

              <ThinkingTicker
                active={live && (gen.status === "connecting" || gen.status === "thinking")}
                thinking={gen.thinking}
                label={thinkingLabel}
              />

              <CodeDrawer open={drawerOpen} html={frameHtml} live={live} onClose={() => setDrawerOpen(false)} />

              {failure ? (
                <Toast
                  tone="error"
                  message={failure.message}
                  actionLabel={failure.retry && lastRun.current ? "Retry" : null}
                  onAction={retry}
                  onDismiss={() => setFailure(null)}
                />
              ) : (
                thrown && (
                  <Toast tone="warn" message={`The app threw: ${thrown}`} actionLabel="Fix it" onAction={fixIt} onDismiss={dismissThrown} />
                )
              )}
            </div>
          </div>
        </section>
      </main>

      <Filmstrip versions={versions} currentIndex={currentIndex} pending={pendingCard} disabled={live} onSelect={select} />
    </div>
  );
}
