// Wire contract between the browser app and the local server.
// POST /api/generate takes a GenerateRequest and answers with NDJSON: one StreamEvent per line.

export type Effort = "low" | "medium" | "high";

// create  = first sketch            (image required)
// iterate = same paper + red pen    (image + currentHtml required, prevImage recommended)
// fix     = runtime error self-heal (currentHtml + runtimeError required)
export type GenerateMode = "create" | "iterate" | "fix";

export interface GenerateRequest {
  mode: GenerateMode;
  /** Base64 JPEG, no `data:` prefix. Never mirrored, never upscaled, long edge <= 2576px. */
  image?: string;
  /** Base64 JPEG of the previous capture, so the model can tell which red marks are new. */
  prevImage?: string;
  /** The app currently on screen, exactly as the model wrote it (vendor URLs included). */
  currentHtml?: string;
  /** Optional typed note from the person. */
  instruction?: string;
  /** Error message forwarded from the sandboxed preview (mode "fix"). */
  runtimeError?: string;
  effort: Effort;
  /** window.location.origin — templated into the system prompt for the /vendor script tags. */
  assetOrigin: string;
  /** Name of a recording to replay instead of calling Claude. */
  replay?: string;
  /** Unattended mode: the server substitutes a recording rather than surfacing an error. */
  kiosk?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Running total of what this machine has spent, and whether there is room for another run. */
export interface BudgetState {
  /** Hard ceiling in USD, or null when there is no cap. */
  capUsd: number | null;
  spentUsd: number;
  runs: number;
  /** False once the cap is reached: the server replays a recording instead of calling the API. */
  canAfford: boolean;
}

export type StreamEvent =
  | { type: "start"; model: string; replay: boolean }
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "done"; stopReason: string | null; usage: Usage; ms: number; model: string }
  | { type: "error"; message: string; retryable: boolean };

export interface HealthResponse {
  ok: boolean;
  hasKey: boolean;
  model: string;
  fastMode: boolean;
  recording: boolean;
  /** Names usable as GenerateRequest.replay */
  recordings: string[];
  budget: BudgetState;
}

export interface SamplesResponse {
  /** URLs under /samples/, e.g. "/samples/expenses.jpg" */
  samples: string[];
}

/** One entry in the filmstrip. Client-side only. */
export interface Version {
  id: string;
  /** data: URL of the captured frame (or sample/upload) that produced this version. */
  imageDataUrl: string | null;
  /** Raw base64 of the same frame, for prevImage on the next iteration. */
  imageBase64: string | null;
  html: string;
  mode: GenerateMode;
  ms: number;
  usage: Usage;
  model: string;
  replay: boolean;
}

// The model is told to use these exact script tags; export rewrites them to the public CDNs.
export const VENDOR_TAILWIND_PATH = "/vendor/tailwind.js";
export const VENDOR_CHART_PATH = "/vendor/chart.js";
export const CDN_TAILWIND_URL = "https://cdn.tailwindcss.com";
export const CDN_CHART_URL = "https://cdn.jsdelivr.net/npm/chart.js";
