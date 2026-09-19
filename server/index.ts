import "./env.ts";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type {
  Effort,
  GenerateMode,
  GenerateRequest,
  HealthResponse,
  SamplesResponse,
  StreamEvent,
} from "../shared/protocol.ts";
import { budgetState, canAfford, capLabel, recordSpend } from "./budget.ts";
import { MODEL, fastModeOn, generate, hasKey } from "./generate.ts";
import { createRecorder, isRecording, listRecordings, replayRecording } from "./replay.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DIST_DIR = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT ?? 8787);

const MODES: readonly GenerateMode[] = ["create", "iterate", "fix"];
const EFFORTS: readonly Effort[] = ["low", "medium", "high"];
const IMAGE_FILE = /\.(jpe?g|png|webp|gif)$/i;

const filled = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stripDataUrl = (value: string): string => value.replace(/^data:[^,]*,/, "");

function parseRequest(body: unknown): GenerateRequest | string {
  if (typeof body !== "object" || body === null) return "Request body must be a JSON object.";
  const raw = body as Partial<Record<keyof GenerateRequest, unknown>>;
  const effort = EFFORTS.find((e) => e === raw.effort) ?? "medium";
  const assetOrigin = typeof raw.assetOrigin === "string" ? raw.assetOrigin : "";

  const kiosk = raw.kiosk === true;

  if (filled(raw.replay)) return { mode: "create", effort, assetOrigin, kiosk, replay: raw.replay };

  const mode = MODES.find((m) => m === raw.mode);
  if (!mode) return 'mode must be "create", "iterate" or "fix".';
  if (mode !== "fix" && !filled(raw.image)) return `Mode "${mode}" needs a captured image.`;
  if (mode !== "create" && !filled(raw.currentHtml)) return `Mode "${mode}" needs the current app (currentHtml).`;
  if (mode === "fix" && !filled(raw.runtimeError)) return 'Mode "fix" needs the runtime error message.';

  return {
    mode,
    effort,
    assetOrigin,
    kiosk,
    image: filled(raw.image) ? stripDataUrl(raw.image) : undefined,
    prevImage: filled(raw.prevImage) ? stripDataUrl(raw.prevImage) : undefined,
    currentHtml: filled(raw.currentHtml) ? raw.currentHtml : undefined,
    instruction: filled(raw.instruction) ? raw.instruction : undefined,
    runtimeError: filled(raw.runtimeError) ? raw.runtimeError : undefined,
  };
}

function openStream(res: Response): (event: StreamEvent) => void {
  res.status(200).set({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  return (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20mb" }));

app.get("/api/health", async (_req, res) => {
  const health: HealthResponse = {
    ok: true,
    hasKey: hasKey(),
    model: MODEL,
    fastMode: fastModeOn(),
    recording: isRecording(),
    recordings: await listRecordings(),
    budget: budgetState(),
  };
  res.json(health);
});

app.get("/api/samples", async (_req, res) => {
  const files = await readdir(path.join(PUBLIC_DIR, "samples")).catch(() => [] as string[]);
  const samples: SamplesResponse = {
    samples: files
      .filter((file) => IMAGE_FILE.test(file))
      .sort()
      .map((file) => `/samples/${encodeURIComponent(file)}`),
  };
  res.json(samples);
});

// Which recording stands in for a run we can no longer afford. The hand-named act files are the
// polished ones, so they go first; rotating means a second visitor doesn't get the first one's app.
let fallbackTurn = 0;
function pickFallback(names: string[]): string | null {
  if (names.length === 0) return null;
  const acts = names.filter((name) => /^act\d/.test(name));
  const pool = acts.length > 0 ? acts : names;
  return pool[fallbackTurn++ % pool.length];
}

app.post("/api/generate", async (req, res) => {
  const send = openStream(res);
  const parsed = parseRequest(req.body);
  if (typeof parsed === "string") {
    send({ type: "error", message: parsed, retryable: false });
    res.end();
    return;
  }

  // "close" also fires after a normal finish, so only a close before res.end() counts as a disconnect.
  const disconnect = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) disconnect.abort();
  });

  try {
    if (parsed.replay) {
      const started = Date.now();
      const outcome = await replayRecording(parsed.replay, parsed.assetOrigin, send, disconnect.signal);
      console.log(`[replay] name=${parsed.replay} ms=${Date.now() - started} outcome=${outcome}`);
    } else if (!canAfford()) {
      // The cap is reached. A kiosk nobody is watching keeps showing apps (from disk, for free);
      // a run someone is standing in front of gets told the truth instead of a silent substitution.
      const { spentUsd, capUsd } = budgetState();
      // A cap of exactly zero isn't a budget that ran out - it's the deliberate "spend nothing right
      // now" switch, used for rehearsing and for calibrating the camera. It always answers with a
      // recording, on every page, because erring there would just look broken.
      const freeMode = capUsd === 0;
      const totals = freeMode ? "BUDGET_USD=0" : `$${spentUsd.toFixed(2)} of the $${(capUsd ?? 0).toFixed(2)} cap`;
      const fallback = parsed.kiosk || freeMode ? pickFallback(await listRecordings()) : null;
      if (fallback) {
        console.log(`[budget] ${freeMode ? "free mode" : `cap reached (${totals} used)`}; replaying ${fallback} instead`);
        await replayRecording(fallback, parsed.assetOrigin, send, disconnect.signal);
      } else {
        console.log(`[budget] ${totals}; refusing the run`);
        send({
          type: "error",
          message: freeMode
            ? "This server is running with BUDGET_USD=0 and has no recordings to answer with. Restart it without BUDGET_USD=0 to make real runs."
            : `Spending cap reached: ${totals} is used, with no room left for another run. Press Shift+R to replay a saved run, or raise BUDGET_USD in .env and restart the server.`,
          retryable: false,
        });
      }
    } else {
      const recorder = isRecording() ? createRecorder(parsed) : null;
      const run = await generate(
        parsed,
        (event) => {
          send(event);
          recorder?.push(event);
        },
        disconnect.signal,
      );
      const tokens = run.usage ? `in=${run.usage.inputTokens} out=${run.usage.outputTokens}` : "in=- out=-";
      const usd = await recordSpend(run.model, run.usage);
      const after = budgetState();
      const money =
        after.capUsd === null
          ? `usd=${usd.toFixed(4)} total=$${after.spentUsd.toFixed(2)}`
          : `usd=${usd.toFixed(4)} left=$${Math.max(0, after.capUsd - after.spentUsd).toFixed(2)}`;
      console.log(
        `[generate] mode=${parsed.mode} model=${run.model} ms=${run.ms} ${tokens} ${money} outcome=${run.outcome}`,
      );
      const saved = await recorder?.save();
      if (saved) console.log(`[record] saved recordings/${saved}.json`);
    }
  } catch (err) {
    console.error("[generate] unexpected failure:", err instanceof Error ? err.message : err);
    send({ type: "error", message: "The server hit an unexpected error. Try again.", retryable: true });
  }
  res.end();
});

app.use("/vendor", express.static(path.join(PUBLIC_DIR, "vendor"), { maxAge: "1h" }));
app.use("/samples", express.static(path.join(PUBLIC_DIR, "samples")));

if (process.env.NODE_ENV === "production") {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    const wantsPage = req.method === "GET" && !req.path.startsWith("/api/") && !path.extname(req.path);
    if (wantsPage) res.sendFile(path.join(DIST_DIR, "index.html"));
    else next();
  });
}

app.use((_req, res) => {
  res.status(404).json({ ok: false, message: "Not found" });
});

// Body-parser failures (bad JSON, payload over 20mb) land here; /api/generate still answers in NDJSON.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const info = typeof err === "object" && err !== null ? (err as { type?: unknown; status?: unknown }) : {};
  const status = typeof info.status === "number" ? info.status : 500;
  const message =
    info.type === "entity.too.large"
      ? "That capture is too large to send (20 MB limit)."
      : info.type === "entity.parse.failed"
        ? "The request body is not valid JSON."
        : status === 404
          ? "Not found"
          : "The server hit an unexpected error.";
  if (status >= 500) console.error("[server]", err instanceof Error ? err.message : err);
  if (res.headersSent) {
    res.end();
  } else if (req.path === "/api/generate") {
    openStream(res)({ type: "error", message, retryable: false });
    res.end();
  } else {
    res.status(status).json({ ok: false, message });
  }
});

app.listen(PORT, (err?: Error) => {
  if (err) {
    console.error(`[server] could not listen on ${PORT}: ${err.message}`);
    process.exit(1);
  }
  const flags = [
    hasKey() ? "key: found" : "key: MISSING (replays only)",
    `budget: $${budgetState().spentUsd.toFixed(2)} spent, ${capLabel()}`,
    fastModeOn() ? "fast mode" : null,
    isRecording() ? "recording" : null,
    process.env.NODE_ENV === "production" ? "serving dist/" : null,
  ].filter(Boolean);
  console.log(`[server] http://localhost:${PORT}  model=${MODEL}  ${flags.join("  ")}`);
  if (process.env.NODE_ENV === "production" && !existsSync(path.join(DIST_DIR, "index.html"))) {
    console.warn("[server] dist/index.html is missing: run `pnpm build` first");
  }
});
