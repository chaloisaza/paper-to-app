import { useEffect, useRef, useState } from "react";
import type { GenerationMeta, GenerationStatus } from "../types";

interface StatusPillProps {
  status: GenerationStatus;
  elapsedMs: number;
  outputChars: number;
  meta: GenerationMeta | null;
  error: string | null;
  modelName: string | null;
  replay: boolean;
  connectingLabel: string;
  thinkingLabel: string;
}

type Tone = "idle" | "ai" | "build" | "ok" | "warn" | "bad";

const DOT: Record<Tone, string> = {
  idle: "bg-white/35",
  ai: "bg-glow",
  build: "bg-paper",
  ok: "bg-emerald-400",
  warn: "bg-ember",
  bad: "bg-redpen",
};

const TEXT: Record<Tone, string> = {
  idle: "text-white/70",
  ai: "text-white/90",
  build: "text-paper",
  ok: "text-white/90",
  warn: "text-ember",
  bad: "text-redpen",
};

const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

export function StatusPill({
  status,
  elapsedMs,
  outputChars,
  meta,
  error,
  modelName,
  replay,
  connectingLabel,
  thinkingLabel,
}: StatusPillProps) {
  const live = status === "connecting" || status === "thinking" || status === "streaming";
  const streaming = status === "streaming";
  const clock = useRef(elapsedMs);
  const [streamFrom, setStreamFrom] = useState<number | null>(null);

  useEffect(() => {
    clock.current = elapsedMs;
  }, [elapsedMs]);

  // Rate is measured from the first output byte, so thinking time does not drag tok/s down.
  useEffect(() => {
    setStreamFrom(streaming ? clock.current : null);
  }, [streaming]);

  const streamSeconds = streamFrom === null ? 0 : (elapsedMs - streamFrom) / 1000;
  const rate = streamSeconds > 0.4 ? Math.round(outputChars / 4 / streamSeconds) : null;

  let tone: Tone = "idle";
  let text = "Ready";
  if (status === "connecting") {
    tone = "ai";
    text = connectingLabel;
  } else if (status === "thinking") {
    tone = "ai";
    text = thinkingLabel;
  } else if (status === "streaming") {
    tone = "build";
    text = `Building… ${seconds(elapsedMs)}${rate === null ? "" : ` · ~${rate} tok/s`}`;
  } else if (status === "done" && meta) {
    const clean = meta.stopReason === "end_turn";
    tone = clean ? "ok" : "warn";
    text = clean
      ? `Built in ${seconds(meta.ms || elapsedMs)} · ${compact(meta.usage.outputTokens)} tokens`
      : `Stopped early · ${meta.stopReason ?? "unknown reason"}`;
  } else if (status === "error") {
    tone = "bad";
    text = error ?? "Something went wrong";
  }

  return (
    <div
      role="status"
      className="flex h-9 max-w-full items-center gap-3 rounded-full bg-white/5 pr-4 pl-3.5 text-sm ring-1 ring-white/10 transition-colors duration-300"
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        {live && <span className={`absolute inset-0 animate-ping rounded-full opacity-70 ${DOT[tone]}`} />}
        <span className={`relative h-2.5 w-2.5 rounded-full transition-colors duration-300 ${DOT[tone]}`} />
      </span>
      <span
        className={`truncate font-medium tabular-nums ${
          tone === "ai" ? "shimmer-text" : `transition-colors duration-300 ${TEXT[tone]}`
        }`}
      >
        {text}
      </span>
      {modelName && (
        <span className="hidden shrink-0 items-center gap-2 border-l border-white/10 pl-3 text-white/45 sm:flex">
          {modelName}
          {replay && (
            <span className="rounded-full bg-ember/15 px-2 py-0.5 text-[0.65rem] font-semibold tracking-wider text-ember uppercase">
              replay
            </span>
          )}
        </span>
      )}
    </div>
  );
}
