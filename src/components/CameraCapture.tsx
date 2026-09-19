import { useCallback, useEffect, useRef, useState } from "react";
import { frameStats, grabSharpest, resetFrameStats } from "../lib/frame";
import { RED_INK_RELEASE, RED_INK_THRESHOLD, detectRedInk } from "../lib/redInk";
import type { CameraCaptureProps } from "../types";

const GUIDE_FRACTION = 0.84;
const GUIDE_INSET = `${((1 - GUIDE_FRACTION) / 2) * 100}%`;
const TICK_MS = 900;
const DEVICE_KEY = "paper-to-app:camera";
const RED_SAMPLE_MS = 200; // ~5 samples a second
const RED_ON_SAMPLES = 2; // consecutive samples above the threshold before we say "yes"
const RED_OFF_SAMPLES = 3; // ... and below the release before we take it back

// Auto-capture (kiosk only). Sampled on the same interval as the red-ink check.
const AUTO_DETAIL_MIN = 12; // grey standard deviation: below this the guide is an empty desk
const AUTO_STILL_MAX = 2.5; // mean per-pixel change: above this it is still being moved around
const AUTO_STILL_SAMPLES = 6; // 6 x RED_SAMPLE_MS = 1.2s of holding steady before it fires
const AUTO_CLEAR_SAMPLES = 5; // the sheet has to leave the guide before another shot is allowed
const AUTO_COOLDOWN_MS = 6000; // ... and at least this long has to pass

type Problem = "denied" | "notfound" | "busy" | "ended" | "unsupported" | "unknown";
type Status = "requesting" | "live" | Problem;

const PROBLEMS: Record<Problem, { title: string; help: string }> = {
  denied: {
    title: "Camera permission denied",
    help: "Click the camera icon in Chrome's address bar and choose Allow, or enable Chrome in macOS System Settings > Privacy & Security > Camera, then try again.",
  },
  notfound: {
    title: "No camera found",
    help: "Plug in a webcam or bring your iPhone close as a Continuity Camera, then try again.",
  },
  busy: {
    title: "Camera is in use",
    help: "Another app (Zoom, Meet, FaceTime, OBS) is holding the camera. Close it, then try again.",
  },
  ended: {
    title: "Camera disconnected",
    help: "The video stream stopped. Reconnect the camera, then try again.",
  },
  unsupported: {
    title: "Camera unavailable on this page",
    help: "Browsers only expose the camera on https or http://localhost. Open the app from localhost.",
  },
  unknown: {
    title: "Camera failed to start",
    help: "Something went wrong while opening the camera. Try again in a moment.",
  },
};

const KEYFRAMES = `
@keyframes pta-flash { from { opacity: .95 } to { opacity: 0 } }
@keyframes pta-count { 0% { opacity: 0; transform: scale(1.5) } 18%, 100% { opacity: 1; transform: scale(1) } }
@keyframes pta-still { from { opacity: 0; transform: scale(1.04) } to { opacity: 1; transform: scale(1) } }
@keyframes pta-scan { from { transform: translateY(-100%) } to { transform: translateY(400%) } }
@keyframes pta-chip { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@keyframes pta-pulse { 0%, 100% { opacity: .55; transform: scale(1) } 50% { opacity: 0; transform: scale(2.1) } }
`;

const TICKS = [
  "-top-0.5 -left-0.5 rounded-tl-2xl border-t-[3px] border-l-[3px]",
  "-top-0.5 -right-0.5 rounded-tr-2xl border-t-[3px] border-r-[3px]",
  "-bottom-0.5 -left-0.5 rounded-bl-2xl border-b-[3px] border-l-[3px]",
  "-right-0.5 -bottom-0.5 rounded-br-2xl border-r-[3px] border-b-[3px]",
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function problemFrom(err: unknown): Problem {
  const name = typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "notfound";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    default:
      return "unknown";
  }
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a[href], summary, [role='button']") !== null;
}

function readStoredDevice(): string {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
}

function CameraIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.2-2h6.2l1.2 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

export function CameraCapture({ disabled = false, captureLabel, onCapture, onRedInk, auto = false, debug = false }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const aliveRef = useRef(true);
  const busyRef = useRef(false);
  const wasDisabled = useRef(disabled);
  const redInkRef = useRef(false);
  // Auto-capture state machine. Refs, because the sampling effect restarts on every disabled/still flip.
  const armedRef = useRef(true);
  const stillStreak = useRef(0);
  const clearStreak = useRef(0);
  const cooldownUntil = useRef(0);
  const latest = useRef({ disabled, status: "requesting" as Status, onCapture, onRedInk });

  const [status, setStatus] = useState<Status>("requesting");
  const [granted, setGranted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [wantedId, setWantedId] = useState(readStoredDevice);
  const [activeId, setActiveId] = useState("");
  const [res, setRes] = useState<{ w: number; h: number } | null>(null);
  const [mirrored, setMirrored] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [flashId, setFlashId] = useState(0);
  const [still, setStill] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [redInk, setRedInk] = useState(false);
  const [stats, setStats] = useState<{ detail: number; change: number } | null>(null);

  useEffect(() => {
    latest.current = { disabled, status, onCapture, onRedInk };
  });

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // The parent re-enabling the component is the signal to thaw the frozen still.
  useEffect(() => {
    if (wasDisabled.current && !disabled) setStill(null);
    wasDisabled.current = disabled;
  }, [disabled]);

  const setRedVerdict = useCallback((next: boolean) => {
    if (redInkRef.current === next) return;
    redInkRef.current = next;
    setRedInk(next);
    latest.current.onRedInk?.(next);
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (aliveRef.current) setDevices(all.filter((d) => d.kind === "videoinput" && d.deviceId));
    } catch {
      // the picker simply stays hidden
    }
  }, []);

  useEffect(() => {
    const media: MediaDevices | undefined = navigator.mediaDevices;
    if (!media) {
      setStatus("unsupported");
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    const video = videoRef.current;
    const syncRes = () => {
      if (video?.videoWidth) setRes({ w: video.videoWidth, h: video.videoHeight });
    };
    video?.addEventListener("loadedmetadata", syncRes);
    video?.addEventListener("resize", syncRes);
    media.addEventListener("devicechange", refreshDevices);
    setStatus("requesting");
    media
      .getUserMedia({
        video: { deviceId: wantedId ? { ideal: wantedId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      .then((opened) => {
        if (cancelled) {
          opened.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = opened;
        const track = opened.getVideoTracks()[0];
        track?.addEventListener("ended", () => {
          if (!cancelled) setStatus("ended");
        });
        setActiveId(track?.getSettings().deviceId ?? "");
        if (video) {
          video.srcObject = opened;
          video.play().catch(() => undefined);
        }
        setStatus("live");
        setGranted(true);
        void refreshDevices();
      })
      .catch((err: unknown) => {
        if (!cancelled) setStatus(problemFrom(err));
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      media.removeEventListener("devicechange", refreshDevices);
      video?.removeEventListener("loadedmetadata", syncRes);
      video?.removeEventListener("resize", syncRes);
      if (video) video.srcObject = null;
    };
  }, [wantedId, attempt, refreshDevices]);

  // If the person flips the site permission to Allow, start the camera without a reload.
  useEffect(() => {
    let cancelled = false;
    let permission: PermissionStatus | null = null;
    const onChange = () => {
      if (permission?.state === "granted" && latest.current.status === "denied") setAttempt((n) => n + 1);
    };
    navigator.permissions
      ?.query({ name: "camera" })
      .then((p) => {
        if (cancelled) return;
        permission = p;
        p.addEventListener("change", onChange);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      permission?.removeEventListener("change", onChange);
    };
  }, []);

  const runCapture = useCallback(async () => {
    const video = videoRef.current;
    const blocked = () => latest.current.disabled || latest.current.status !== "live";
    if (!video || busyRef.current || blocked()) return;
    busyRef.current = true;
    setStill(null);
    setNotice(null);
    try {
      for (let n = 3; n >= 1; n--) {
        setCount(n);
        await sleep(TICK_MS);
        if (!aliveRef.current || blocked()) return;
      }
      setCount(null);
      setGrabbing(true);
      setFlashId((id) => id + 1);
      const frame = await grabSharpest(video, GUIDE_FRACTION);
      if (!aliveRef.current) return;
      setStill(frame.dataUrl);
      latest.current.onCapture(frame);
    } catch {
      setNotice("Capture failed. Press Space to try again.");
    } finally {
      busyRef.current = false;
      setCount(null);
      setGrabbing(false);
    }
  }, []);

  // Watch the live preview for red-pen marks: a few samples a second, on a small reused
  // canvas, and only while there is something worth looking at.
  useEffect(() => {
    const video = videoRef.current;
    const idle = !video || status !== "live";
    // Losing the camera really is "no red ink in view"; pausing for a generation is not, so a
    // frozen still or a disabled component keeps the last verdict instead of retracting it.
    if (idle) setRedVerdict(false);
    if (idle || disabled || still) return;
    let streak = 0;
    // The previous sample is from before the pause, so throw it away: the first reading after a
    // restart must say "moving", never "steady".
    resetFrameStats();
    stillStreak.current = 0;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const { ratio } = detectRedInk(video, GUIDE_FRACTION);
      const on = redInkRef.current;
      const agrees = on ? ratio < RED_INK_RELEASE : ratio >= RED_INK_THRESHOLD;
      streak = agrees ? streak + 1 : 0;
      if (streak >= (on ? RED_OFF_SAMPLES : RED_ON_SAMPLES)) {
        streak = 0;
        setRedVerdict(!on);
      }

      if (!auto && !debug) return;
      const { detail, change } = frameStats(video, GUIDE_FRACTION);
      if (debug) setStats({ detail, change });
      if (!auto || busyRef.current) return;

      const hasPaper = detail >= AUTO_DETAIL_MIN;
      if (!armedRef.current) {
        // Disarmed after a shot: the sheet has to go away before this can fire again, which is what
        // stops a hand resting in frame from triggering a run every six seconds.
        clearStreak.current = hasPaper ? 0 : clearStreak.current + 1;
        if (clearStreak.current >= AUTO_CLEAR_SAMPLES) {
          armedRef.current = true;
          clearStreak.current = 0;
        }
        stillStreak.current = 0;
        return;
      }

      stillStreak.current = hasPaper && change <= AUTO_STILL_MAX ? stillStreak.current + 1 : 0;
      if (stillStreak.current >= AUTO_STILL_SAMPLES && Date.now() >= cooldownUntil.current) {
        stillStreak.current = 0;
        armedRef.current = false;
        cooldownUntil.current = Date.now() + AUTO_COOLDOWN_MS;
        void runCapture();
      }
    }, RED_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [status, disabled, still, auto, debug, runCapture, setRedVerdict]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.code === "Space") {
        const { disabled: off, status: now } = latest.current;
        const canFire = !off && !busyRef.current && now === "live";
        if (!canFire && !busyRef.current && isControl(e.target)) return;
        e.preventDefault();
        if (canFire) void runCapture();
      } else if (e.key === "m" || e.key === "M") {
        setMirrored((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runCapture]);

  const pickDevice = (id: string) => {
    setWantedId(id);
    setAttempt((n) => n + 1);
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      // storage can be blocked; the choice still applies for this session
    }
  };

  const live = status === "live";
  const busy = count !== null || grabbing;
  const problem = status !== "live" && status !== "requesting" ? PROBLEMS[status] : null;
  const wide = res ? res.w / res.h >= 16 / 9 : true;
  const pill = grabbing ? "Hold still" : notice;
  const showRedInk = redInk && !disabled && !still;

  return (
    <div className="flex w-full flex-col gap-3">
      <style>{KEYFRAMES}</style>

      <div className="@container relative aspect-video w-full overflow-hidden rounded-2xl bg-neutral-950 ring-1 ring-white/10">
        <div
          className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 ${wide ? "w-full" : "h-full"}`}
          style={{ aspectRatio: res ? `${res.w} / ${res.h}` : "16 / 9" }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`h-full w-full object-cover transition-opacity duration-300 ${live ? "opacity-100" : "opacity-0"}`}
            style={{ transform: mirrored ? "scaleX(-1)" : undefined }}
          />

          {live && !still && (
            <div
              className={`pointer-events-none absolute rounded-2xl border-2 border-dashed shadow-[0_0_0_100vmax_rgba(0,0,0,0.38)] transition-colors duration-300 ${showRedInk ? "border-[#ef4444]/85" : "border-[#f5ecd7]/70"}`}
              style={{ inset: GUIDE_INSET }}
            >
              {TICKS.map((tick) => (
                <span
                  key={tick}
                  className={`absolute h-6 w-6 transition-colors duration-300 ${showRedInk ? "border-[#ef4444]" : "border-[#f5ecd7]"} ${tick}`}
                />
              ))}
              {!busy && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-3 py-0.5 text-[11px] font-medium tracking-wide whitespace-nowrap text-[#f5ecd7]">
                  Fit your paper inside the frame
                </span>
              )}
            </div>
          )}

          {still && (
            <>
              <img
                src={still}
                alt="Captured sketch"
                className="absolute inset-0 h-full w-full animate-[pta-still_400ms_ease-out_both] object-cover"
              />
              {disabled && (
                <div className="pointer-events-none absolute inset-x-0 top-0 h-1/4 animate-[pta-scan_1.8s_linear_infinite] border-b border-[#f5ecd7]/80 bg-linear-to-b from-transparent to-[#f5ecd7]/25" />
              )}
              <span className="absolute top-3 left-3 rounded-full bg-black/70 px-3 py-1 text-[11px] font-semibold tracking-widest text-[#f5ecd7] uppercase">
                {disabled ? "Reading your sketch" : "Captured"}
              </span>
            </>
          )}
        </div>

        {count !== null && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35">
            <span
              key={count}
              style={{ animationDuration: `${TICK_MS}ms` }}
              className="animate-[pta-count_1s_ease-out_both] text-[length:34cqw] leading-none font-black text-[#f5ecd7] tabular-nums [text-shadow:0_0.04em_0.3em_rgba(0,0,0,0.65)]"
            >
              {count}
            </span>
          </div>
        )}

        {flashId > 0 && (
          <div key={flashId} className="pointer-events-none absolute inset-0 animate-[pta-flash_250ms_ease-out_forwards] bg-white" />
        )}

        {showRedInk && (
          <div className="pointer-events-none absolute bottom-4 left-4 flex animate-[pta-chip_200ms_ease-out_both] items-center gap-2 rounded-full bg-black/75 py-1.5 pr-3.5 pl-3 text-[11px] font-semibold tracking-wide text-[#ff8080] ring-1 ring-[#ef4444]/45">
            <span className="relative flex h-2 w-2 items-center justify-center">
              <span className="absolute h-2 w-2 animate-[pta-pulse_1.8s_ease-out_infinite] rounded-full bg-[#ef4444] motion-reduce:hidden" />
              <span className="h-2 w-2 rounded-full bg-[#ef4444]" />
            </span>
            Red ink detected
          </div>
        )}

        {debug && stats && (
          <div className="pointer-events-none absolute right-4 bottom-4 rounded-lg bg-black/80 px-2.5 py-1.5 text-right font-mono text-[11px] leading-tight text-[#f5ecd7] tabular-nums ring-1 ring-white/15">
            <div>
              detail {stats.detail.toFixed(1)} <span className="text-white/40">/ {AUTO_DETAIL_MIN}</span>
            </div>
            <div>
              change {Number.isFinite(stats.change) ? stats.change.toFixed(2) : "\u2014"}{" "}
              <span className="text-white/40">/ {AUTO_STILL_MAX}</span>
            </div>
            <div className="text-white/45">{armedRef.current ? "armed" : "waiting for the sheet to leave"}</div>
          </div>
        )}

        {pill && !still && (
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-4 py-1.5 text-sm font-medium text-[#f5ecd7]">
            {pill}
          </span>
        )}

        {status === "requesting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="relative flex h-12 w-12 items-center justify-center text-[#f5ecd7]">
              <span className="absolute inset-0 animate-ping rounded-full bg-[#f5ecd7]/20" />
              <CameraIcon className="h-7 w-7" />
            </span>
            <p className="text-lg font-semibold text-white">{granted ? "Starting camera" : "Waiting for camera access"}</p>
            {!granted && (
              <p className="max-w-md text-sm text-white/60">
                Choose Allow when the browser asks. Upload and Samples work without a camera.
              </p>
            )}
          </div>
        )}

        {problem && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <CameraIcon className="h-9 w-9 text-white/40" />
            <p className="text-lg font-semibold text-white">{problem.title}</p>
            <p className="max-w-lg text-sm text-white/60">{problem.help}</p>
            <p className="text-sm text-[#f5ecd7]/85">No camera needed to continue: use Upload or Samples instead.</p>
            {status !== "unsupported" && (
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="mt-2 rounded-lg bg-white/10 px-4 py-1.5 text-sm font-medium text-white ring-1 ring-white/15 transition hover:bg-white/20"
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        disabled={!live || disabled || busy}
        onClick={(e) => {
          e.currentTarget.blur();
          void runCapture();
        }}
        className="flex w-full items-center justify-center gap-3 rounded-xl bg-[#f5ecd7] px-5 py-3.5 text-base font-semibold text-neutral-900 shadow-lg shadow-black/30 transition enabled:hover:bg-white enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <CameraIcon className="h-5 w-5" />
        {busy ? "Hold still" : captureLabel}
        <kbd className="rounded-md bg-neutral-900/10 px-2 py-0.5 font-mono text-xs font-medium">Space</kbd>
      </button>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-white/50">
        <span className="flex items-center gap-2 font-mono tabular-nums">
          <span className={`h-2 w-2 rounded-full ${live ? "bg-emerald-400" : "bg-white/20"}`} />
          {live && res ? `${res.w}x${res.h}` : "no signal"}
          {mirrored && <span className="rounded bg-white/10 px-1.5 py-0.5 font-sans text-white/70">mirrored preview</span>}
        </span>
        <span>Space to capture · M to mirror</span>
        {devices.length > 1 && (
          <select
            aria-label="Camera"
            value={activeId}
            disabled={busy}
            onChange={(e) => {
              pickDevice(e.target.value);
              e.currentTarget.blur();
            }}
            className="max-w-56 truncate rounded-lg bg-white/5 px-2 py-1 text-xs text-white/80 ring-1 ring-white/10 outline-none [color-scheme:dark] focus:ring-white/30 disabled:opacity-40"
          >
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
