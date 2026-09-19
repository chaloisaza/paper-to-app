import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { GenerateRequest, StreamEvent } from "../../shared/protocol";
import type { GenerationStatus, UseGenerationResult } from "../types";
import { cleanHtmlStream } from "../lib/htmlStream";

type State = Omit<UseGenerationResult, "start" | "abort">;

const IDLE: State = {
  status: "idle",
  generationId: null,
  thinking: "",
  html: "",
  outputChars: 0,
  elapsedMs: 0,
  meta: null,
  error: null,
};

/** One run. Its identity is the run token: a run that is no longer `current` can never write state. */
interface Run {
  controller: AbortController;
  startedAt: number;
  status: GenerationStatus;
  raw: string;
  thinking: string;
  model: string;
  replay: boolean;
  connected: boolean;
  raf: number;
  timer: number;
}

async function failureMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text.split("\n")[0]) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  } catch {
    // not JSON: fall through to the status line
  }
  return `The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`;
}

function createEngine(setState: Dispatch<SetStateAction<State>>) {
  let current: Run | null = null;

  const patch = (run: Run, next: Partial<State>) => {
    if (current === run) setState((s) => ({ ...s, ...next }));
  };
  const buffers = (run: Run) => ({ thinking: run.thinking, html: cleanHtmlStream(run.raw), outputChars: run.raw.length });

  const schedule = (run: Run) => {
    if (run.raf) return;
    run.raf = requestAnimationFrame(() => {
      run.raf = 0;
      patch(run, buffers(run));
    });
  };
  const phase = (run: Run, status: GenerationStatus) => {
    run.status = status;
    patch(run, { status });
  };
  const stop = (run: Run) => {
    cancelAnimationFrame(run.raf);
    window.clearInterval(run.timer);
  };
  const finish = (run: Run, next: Partial<State>) => {
    if (current !== run) return;
    stop(run);
    patch(run, { ...buffers(run), elapsedMs: performance.now() - run.startedAt, ...next });
    current = null;
  };

  const handle = (run: Run, line: string) => {
    if (current !== run || !line.trim()) return;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line) as StreamEvent;
    } catch {
      return;
    }
    switch (ev?.type) {
      case "start":
        run.model = ev.model;
        run.replay = ev.replay;
        break;
      case "thinking":
        run.thinking += ev.delta;
        if (run.status === "connecting") phase(run, "thinking");
        schedule(run);
        break;
      case "text":
        run.raw += ev.delta;
        if (run.status !== "streaming") phase(run, "streaming");
        schedule(run);
        break;
      case "done":
        finish(run, {
          status: "done",
          meta: { model: ev.model || run.model, replay: run.replay, ms: ev.ms, usage: ev.usage, stopReason: ev.stopReason },
        });
        break;
      case "error":
        finish(run, { status: "error", error: { message: ev.message, retryable: ev.retryable } });
        break;
    }
  };

  const start = async (request: GenerateRequest): Promise<void> => {
    if (current) {
      stop(current);
      current.controller.abort();
    }
    const run: Run = {
      controller: new AbortController(),
      startedAt: performance.now(),
      status: "connecting",
      raw: "",
      thinking: "",
      model: "",
      replay: Boolean(request.replay),
      connected: false,
      raf: 0,
      timer: 0,
    };
    current = run;
    setState({ ...IDLE, status: "connecting", generationId: crypto.randomUUID() });
    run.timer = window.setInterval(() => patch(run, { elapsedMs: performance.now() - run.startedAt }), 100);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: run.controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(await failureMessage(res));
      run.connected = true;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let tail = "";
      for (;;) {
        const { done, value } = await reader.read();
        tail += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = tail.split("\n");
        tail = done ? "" : (lines.pop() ?? "");
        for (const line of lines) handle(run, line);
        if (done) break;
      }
      finish(run, { status: "error", error: { message: "The stream ended before the app was finished.", retryable: true } });
    } catch (err) {
      if (run.controller.signal.aborted) return finish(run, { status: "idle" });
      const message =
        err instanceof TypeError
          ? run.connected
            ? "The connection dropped mid-stream."
            : "Cannot reach the local server. Is it running?"
          : err instanceof Error
            ? err.message
            : String(err);
      finish(run, { status: "error", error: { message, retryable: true } });
    }
  };

  const abort = () => {
    const run = current;
    if (!run) return;
    run.controller.abort();
    finish(run, { status: "idle" });
  };

  /** Unmount: silence and cancel the run without touching React state. */
  const dispose = () => {
    const run = current;
    current = null;
    if (!run) return;
    stop(run);
    run.controller.abort();
  };

  return { start, abort, dispose };
}

export function useGeneration(): UseGenerationResult {
  const [state, setState] = useState<State>(IDLE);
  const [engine] = useState(() => createEngine(setState));
  useEffect(() => engine.dispose, [engine]);
  return useMemo(() => ({ ...state, start: engine.start, abort: engine.abort }), [state, engine]);
}
