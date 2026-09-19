import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GenerateMode, GenerateRequest, StreamEvent } from "../shared/protocol.ts";
import type { Emit } from "./generate.ts";
import { parseOrigin } from "./prompts.ts";

const RECORDINGS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../recordings");
const SPEED = 2;
const MAX_GAP_MS = 1500;

export interface Recording {
  name: string;
  mode: GenerateMode;
  model: string;
  image: string | null;
  events: { t: number; event: StreamEvent }[];
}

export const isRecording = (): boolean => process.env.RECORD === "1";

export async function listRecordings(): Promise<string[]> {
  try {
    const files = await readdir(RECORDINGS_DIR);
    return files
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

function timestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export interface Recorder {
  push: (event: StreamEvent) => void;
  /** Writes the file when the run reached `done` with a committable stop reason; resolves to the recording name, else null. */
  save: () => Promise<string | null>;
}

export function createRecorder(req: GenerateRequest): Recorder {
  const startedAt = new Date();
  const events: Recording["events"] = [];
  return {
    push: (event) => events.push({ t: Date.now() - startedAt.getTime(), event }),
    save: async () => {
      const done = events.find(({ event }) => event.type === "done")?.event;
      if (done?.type !== "done" || done.stopReason !== "end_turn") return null;
      const name = `${req.mode}-${timestamp(startedAt)}`;
      const recording: Recording = { name, mode: req.mode, model: done.model, image: req.image ?? null, events };
      await mkdir(RECORDINGS_DIR, { recursive: true });
      await writeFile(path.join(RECORDINGS_DIR, `${name}.json`), JSON.stringify(recording));
      return name;
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

const VENDOR_ORIGIN = /https?:\/\/[^\s"'<>]+?(?=\/vendor\/(?:tailwind|chart)\.js)/g;

// A run recorded on :5173 must still find /vendor when replayed from :8787, so the vendor script
// origins are pointed at the caller. Delta boundaries are kept (the last delta absorbs the length change).
function retarget(events: Recording["events"], origin: string | null): Recording["events"] {
  if (!origin) return events;
  const deltas = events.flatMap(({ event }) => (event.type === "text" ? [event.delta] : []));
  const html = deltas.join("").replace(VENDOR_ORIGIN, origin);
  let cursor = 0;
  let seen = 0;
  return events.map((entry) => {
    if (entry.event.type !== "text") return entry;
    const end = ++seen === deltas.length ? html.length : cursor + entry.event.delta.length;
    const delta = html.slice(cursor, end);
    cursor = end;
    return { t: entry.t, event: { type: "text", delta } };
  });
}

/** Re-emits a saved run at 2x speed. Resolves to the outcome for the log line. */
export async function replayRecording(
  name: string,
  assetOrigin: unknown,
  emit: Emit,
  signal: AbortSignal,
): Promise<string> {
  // Exact match against the listing: traversal-safe, and every name /api/health advertises is playable.
  let recording: Recording | null = null;
  if ((await listRecordings()).includes(name)) {
    try {
      recording = JSON.parse(await readFile(path.join(RECORDINGS_DIR, `${name}.json`), "utf8")) as Recording;
    } catch {
      recording = null;
    }
  }
  if (!recording) {
    emit({ type: "error", message: `Recording "${name}" was not found or is not valid JSON.`, retryable: false });
    return "missing";
  }

  const started = Date.now();
  let previous = 0;
  for (const { t, event } of retarget(recording.events, parseOrigin(assetOrigin))) {
    const gap = Math.min((t - previous) / SPEED, MAX_GAP_MS);
    previous = t;
    if (gap > 0) await sleep(gap, signal);
    if (signal.aborted) return "aborted";
    if (event.type === "start") emit({ ...event, replay: true });
    else if (event.type === "done") emit({ ...event, ms: Date.now() - started });
    else if (event.type !== "text" || event.delta) emit(event);
  }
  return "done";
}
