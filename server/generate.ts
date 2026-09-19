import Anthropic from "@anthropic-ai/sdk";
import type { GenerateRequest, StreamEvent, Usage } from "../shared/protocol.ts";
import { buildSystemPrompt, buildUserContent } from "./prompts.ts";

export type Emit = (event: StreamEvent) => void;
type ErrorEvent = Extract<StreamEvent, { type: "error" }>;
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

export interface RunSummary {
  model: string;
  ms: number;
  usage: Usage | null;
  /** stop reason, "aborted", or "error: ..." */
  outcome: string;
}

export const MODEL = process.env.PAPER_MODEL?.trim() || "claude-fable-5-1";

const FAST_CAPABLE = MODEL.startsWith("claude-opus-5") || MODEL.startsWith("claude-opus-4-8");

// Optional betas. A 400 before any output switches one off for the rest of the process, once a retry without it succeeds.
const optional = {
  fallback: process.env.REFUSAL_FALLBACK !== "0",
  fast: process.env.FAST_MODE === "1" && FAST_CAPABLE,
};

export const hasKey = (): boolean =>
  Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());

export const fastModeOn = (): boolean => optional.fast;

let client: Anthropic | null = null;
const getClient = (): Anthropic => (client ??= new Anthropic({ maxRetries: 3 }));

function buildParams(req: GenerateRequest, useFast: boolean): StreamParams {
  const params: StreamParams = {
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: req.effort },
    system: buildSystemPrompt(req.assetOrigin),
    messages: [{ role: "user", content: buildUserContent(req) }],
  };
  const betas: Anthropic.Beta.AnthropicBeta[] = [];
  if (optional.fallback) {
    betas.push("server-side-fallback-2026-07-01");
    params.fallbacks = "default";
  }
  if (useFast) {
    betas.push("fast-mode-2026-02-01");
    params.speed = "fast";
  }
  if (betas.length > 0) params.betas = betas;
  return params;
}

function apiMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const inner = body?.error?.message;
  return typeof inner === "string" && inner ? inner : err.message;
}

function toErrorEvent(err: unknown): ErrorEvent {
  const event = (message: string, retryable: boolean): ErrorEvent => ({ type: "error", message, retryable });

  if (err instanceof Anthropic.AuthenticationError) {
    return event("The API key was rejected. Check ANTHROPIC_API_KEY in .env, then restart the server.", false);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return event(`This API key is not allowed to use ${MODEL}: ${apiMessage(err)}`, false);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return event(`Model "${MODEL}" was not found. Check PAPER_MODEL in .env.`, false);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return event("Rate limited by the API. Give it a few seconds and try again.", true);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return event("Could not reach the Anthropic API. Check the network and try again.", true);
  }
  if (err instanceof Anthropic.APIError) {
    // No status means the failure arrived as an error event on an already-open stream.
    const transient = err.status === undefined || err.status >= 500;
    return transient
      ? event(`The API had a hiccup (${err.status ?? "stream error"}). Try again.`, true)
      : event(`The API rejected the request (${err.status}): ${apiMessage(err)}`, false);
  }
  if (err instanceof Anthropic.AnthropicError) {
    // The SDK wraps a response body that dies mid-stream in a plain AnthropicError.
    return event("The connection to the Anthropic API dropped mid-stream. Try again.", true);
  }
  return event(err instanceof Error ? `Unexpected server error: ${err.message}` : "Unexpected server error.", true);
}

export async function generate(req: GenerateRequest, emit: Emit, signal: AbortSignal): Promise<RunSummary> {
  const started = Date.now();
  const summary = (outcome: string, extra: Partial<RunSummary> = {}): RunSummary => ({
    model: MODEL,
    ms: Date.now() - started,
    usage: null,
    outcome,
    ...extra,
  });
  const fail = (event: ErrorEvent): RunSummary => {
    emit(event);
    return summary(`error: ${event.message}`);
  };

  if (!hasKey()) {
    return fail({
      type: "error",
      message: "No API key found. Add ANTHROPIC_API_KEY to .env, then restart the server.",
      retryable: false,
    });
  }

  emit({ type: "start", model: MODEL, replay: false });

  let useFast = optional.fast;
  let rateRetried = false;
  const dropped: (keyof typeof optional)[] = [];
  // A drop only sticks when the retry that followed it succeeds.
  const restoreDropped = () => {
    for (const key of dropped) optional[key] = true;
  };

  while (!signal.aborted) {
    const stream = getClient().beta.messages.stream(buildParams(req, useFast));
    const onAbort = () => stream.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let streamed = false;

    try {
      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "thinking_delta" && event.delta.thinking) {
          streamed = true;
          emit({ type: "thinking", delta: event.delta.thinking });
        } else if (event.delta.type === "text_delta" && event.delta.text) {
          streamed = true;
          emit({ type: "text", delta: event.delta.text });
        }
      }
      const final = await stream.finalMessage();
      const usage: Usage = { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens };
      const ms = Date.now() - started;
      emit({ type: "done", stopReason: final.stop_reason, usage, ms, model: final.model });
      // Fast is dropped before fallback; when both went, the first one is probably innocent, so re-probe it next time.
      if (dropped.length === 2) optional[dropped[0]] = true;
      return summary(final.stop_reason ?? "unknown", { model: final.model, ms, usage });
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) break;

      if (!streamed && err instanceof Anthropic.BadRequestError) {
        const drop = useFast ? "fast" : optional.fallback ? "fallback" : null;
        if (drop) {
          optional[drop] = false;
          dropped.push(drop);
          useFast = false;
          console.warn(`[generate] 400 with optional betas on; retrying without ${drop}`);
          continue;
        }
      }

      if (!streamed && useFast && !rateRetried && err instanceof Anthropic.RateLimitError) {
        useFast = false;
        rateRetried = true;
        console.warn("[generate] fast mode rate limited; retrying at standard speed");
        continue;
      }

      restoreDropped();
      return fail(toErrorEvent(err));
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  restoreDropped();
  return summary("aborted");
}
