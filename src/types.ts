// Client-side contracts between components. Builders code against these; do not change
// a signature without updating every user of it.
import type { GenerateRequest, Usage } from "../shared/protocol";

/** A still frame ready to send to the server. */
export interface CapturedFrame {
  /** Base64 JPEG, no `data:` prefix. Never mirrored. Long edge <= 2576px, never upscaled. */
  base64: string;
  /** data:image/jpeg;base64,... of the same pixels, for thumbnails and the wipe slider. */
  dataUrl: string;
  width: number;
  height: number;
}

export interface CameraCaptureProps {
  /** True while a generation is running: Space and the button do nothing. */
  disabled?: boolean;
  /** Label for the big button, e.g. "Capture sketch" or "Apply red-pen edits". */
  captureLabel: string;
  /** Fired once per capture, after the countdown, with the sharpest of the grabbed frames. */
  onCapture: (frame: CapturedFrame) => void;
  /** Fired when the live red-ink detector changes its mind about the frame in view. */
  onRedInk?: (present: boolean) => void;
  /** Kiosk: fire a capture on its own once a sheet is in the guide and holding still. */
  auto?: boolean;
  /** Show the live detail/stillness readings, for calibrating the auto-capture thresholds. */
  debug?: boolean;
}

export interface PreviewFrameProps {
  /** Changes whenever a different document should be shown (new generation or restored version).
   *  A new id means: start a fresh sandboxed iframe and write `html` from the beginning. */
  generationId: string | null;
  /** Clean HTML accumulated so far. Grows by appending while streaming (prefix-stable). */
  html: string;
  /** True once the document is finished: the frame calls document.close(). */
  complete: boolean;
  /** data: URL of the capture behind this version. Shown while the app has not painted yet
   *  (scan overlay) and revealed again by the compare wipe once it is complete. */
  sketchDataUrl?: string | null;
  /** True between "sent" and the first painted markup: the scan overlay owns the stage. */
  scanning?: boolean;
  /** Runtime error caught inside the sandboxed app (window.onerror / unhandledrejection). */
  onRuntimeError?: (message: string) => void;
}

export type GenerationStatus = "idle" | "connecting" | "thinking" | "streaming" | "done" | "error";

export interface GenerationMeta {
  model: string;
  replay: boolean;
  ms: number;
  usage: Usage;
  stopReason: string | null;
}

export interface UseGenerationResult {
  status: GenerationStatus;
  /** Id of the run in progress or last finished; feeds PreviewFrameProps.generationId. */
  generationId: string | null;
  /** Summarized thinking text streamed so far. */
  thinking: string;
  /** Clean HTML so far (fences and chatter stripped, cut after </html>). Prefix-stable. */
  html: string;
  /** Raw output characters received, for the tokens/sec readout. */
  outputChars: number;
  /** ms since start() while running; final duration once done. */
  elapsedMs: number;
  /** Set when status is "done". stopReason !== "end_turn" means the html must not be committed. */
  meta: GenerationMeta | null;
  error: { message: string; retryable: boolean } | null;
  /** Starts a run, aborting any run in flight. Resolves when the stream ends (any outcome). */
  start: (request: GenerateRequest) => Promise<void>;
  abort: () => void;
}
