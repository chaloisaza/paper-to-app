import type { CapturedFrame } from "../types";

export type { CapturedFrame } from "../types";

export type FrameSource = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | ImageBitmap;

export const MAX_LONG_EDGE = 2576;
const JPEG_QUALITY = 0.9;
const SHARPNESS_WIDTH = 320;
const WATCH_WIDTH = 64;

let scratch: HTMLCanvasElement | null = null;
let watch: HTMLCanvasElement | null = null;
let watchCtx: CanvasRenderingContext2D | null = null;
let watchPrev: Float32Array | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sizeOf(source: FrameSource): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) return { width: source.videoWidth, height: source.videoHeight };
  if (source instanceof HTMLImageElement) return { width: source.naturalWidth, height: source.naturalHeight };
  return { width: source.width, height: source.height };
}

function context2d(canvas: HTMLCanvasElement, readback = false): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: readback });
  if (!ctx) throw new Error("Canvas 2D is not available");
  return ctx;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image: ${url}`));
    img.src = url;
  });
}

export function canvasToFrame(canvas: HTMLCanvasElement): CapturedFrame {
  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), dataUrl, width: canvas.width, height: canvas.height };
}

/** Copies `source` onto a canvas whose long edge is at most `maxLongEdge`. Never upscales. */
export function downscaleToMax(source: FrameSource, maxLongEdge = MAX_LONG_EDGE): HTMLCanvasElement {
  const { width, height } = sizeOf(source);
  if (!width || !height) throw new Error("Image has no pixels");
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  if (scale === 1 && source instanceof HTMLCanvasElement) return source;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = context2d(canvas);
  ctx.fillStyle = "#fff"; // JPEG has no alpha: transparent uploads land on white paper, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Raw (unmirrored) stream pixels of the centered guide rectangle, at native resolution. */
export function cropToGuide(video: HTMLVideoElement, guideFraction: number): HTMLCanvasElement {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) throw new Error("Camera is not ready yet");
  const fraction = Math.min(1, Math.max(0.1, guideFraction));
  const width = Math.round(videoWidth * fraction);
  const height = Math.round(videoHeight * fraction);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const sx = Math.round((videoWidth - width) / 2);
  const sy = Math.round((videoHeight - height) / 2);
  context2d(canvas).drawImage(video, sx, sy, width, height, 0, 0, width, height);
  return canvas;
}

/** Variance of a 3x3 Laplacian over a 320px-wide grayscale copy. Higher means sharper. */
export function sharpness(canvas: HTMLCanvasElement): number {
  if (!canvas.width || !canvas.height) return 0;
  const w = SHARPNESS_WIDTH;
  const h = Math.max(3, Math.round((canvas.height / canvas.width) * w));
  scratch ??= document.createElement("canvas");
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;
  const ctx = context2d(scratch, true);
  ctx.drawImage(canvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  let sum = 0;
  let sumSq = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = gray[i - w] + gray[i - 1] + gray[i + 1] + gray[i + w] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
    }
  }
  const n = (w - 2) * (h - 2);
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export interface FrameStats {
  /** Standard deviation of the grey copy, 0-255. Low means there is nothing in the guide worth reading. */
  detail: number;
  /** Mean absolute difference against the previous sample, 0-255. Low means it is holding still. */
  change: number;
}

/** Never still, so a caller that has lost its history can't mistake the first sample for a steady shot. */
const UNKNOWN: FrameStats = { detail: 0, change: Number.POSITIVE_INFINITY };

/** Forgets the previous sample, so the next `frameStats` call reports "moving" rather than comparing
 *  against a frame from before the camera paused. */
export function resetFrameStats(): void {
  watchPrev = null;
}

/**
 * Cheap "is a sheet of paper sitting still in the guide?" reading, meant to be polled a few times a
 * second next to `detectRedInk`. Runs on a 64px grey copy on its own reused canvas, so it never
 * competes with the scratch canvas `sharpness` uses during a capture.
 */
export function frameStats(video: HTMLVideoElement, guideFraction: number): FrameStats {
  const { videoWidth: sw, videoHeight: sh } = video;
  if (!sw || !sh) return UNKNOWN;

  const fraction = Math.min(1, Math.max(0.1, guideFraction));
  const cropW = Math.max(1, Math.round(sw * fraction));
  const cropH = Math.max(1, Math.round(sh * fraction));
  const w = Math.max(1, Math.min(WATCH_WIDTH, cropW));
  const h = Math.max(1, Math.round((cropH / cropW) * w));

  watch ??= document.createElement("canvas");
  if (watch.width !== w) watch.width = w;
  if (watch.height !== h) watch.height = h;
  watchCtx ??= watch.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!watchCtx) return UNKNOWN;

  try {
    watchCtx.drawImage(video, Math.round((sw - cropW) / 2), Math.round((sh - cropH) / 2), cropW, cropH, 0, 0, w, h);
    const { data } = watchCtx.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      const value = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      gray[i] = value;
      sum += value;
    }
    const mean = sum / gray.length;
    let variance = 0;
    for (let i = 0; i < gray.length; i++) {
      const d = gray[i] - mean;
      variance += d * d;
    }
    const detail = Math.sqrt(variance / gray.length);

    let change = Number.POSITIVE_INFINITY;
    if (watchPrev && watchPrev.length === gray.length) {
      let diff = 0;
      for (let i = 0; i < gray.length; i++) diff += Math.abs(gray[i] - watchPrev[i]);
      change = diff / gray.length;
    }
    watchPrev = gray;
    return { detail, change };
  } catch {
    return UNKNOWN; // a not-yet-ready video frame must never fire a capture
  }
}

/** Grabs `count` guide crops spread over `spanMs` and encodes the sharpest one. */
export async function grabSharpest(
  video: HTMLVideoElement,
  guideFraction: number,
  count = 4,
  spanMs = 400,
): Promise<CapturedFrame> {
  const shots = Math.max(1, Math.floor(count));
  const gap = shots > 1 ? spanMs / (shots - 1) : 0;
  const startedAt = performance.now();
  let best = cropToGuide(video, guideFraction);
  let bestScore = sharpness(best);
  for (let i = 1; i < shots; i++) {
    await sleep(Math.max(0, startedAt + i * gap - performance.now()));
    const shot = cropToGuide(video, guideFraction);
    const score = sharpness(shot);
    if (score > bestScore) {
      best = shot;
      bestScore = score;
    }
  }
  return canvasToFrame(downscaleToMax(best));
}

export async function urlToFrame(url: string): Promise<CapturedFrame> {
  return canvasToFrame(downscaleToMax(await loadImage(url)));
}

export async function fileToFrame(file: File): Promise<CapturedFrame> {
  const url = URL.createObjectURL(file);
  try {
    return await urlToFrame(url);
  } catch {
    throw new Error(`Could not read "${file.name}" as an image`);
  } finally {
    URL.revokeObjectURL(url);
  }
}
