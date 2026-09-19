// Live red-pen detector. Dependency-free, runs on a small reused copy of the frame so it
// can be polled a few times a second without touching the capture path.

export type RedInkSource = HTMLCanvasElement | HTMLVideoElement;

/** Fraction of sampled pixels that must read as red ink before we say it is there. */
export const RED_INK_THRESHOLD = 0.004;
/** Lower bar for saying it is gone again: the gap is the hysteresis. */
export const RED_INK_RELEASE = 0.002;

// 320px keeps thin pen strokes alive: measured on public/samples/expenses-red.png the same
// mark reads 0.07% of pixels at 160px, 0.36% at 240px and 0.97% at 320px, while the two
// red-free sketches stay at 0.000% at every width.
const SAMPLE_WIDTH = 320;
const MIN_VALUE = 0.28; // HSV value: rejects black pen, shadows and dim paper
const MIN_SATURATION = 0.4; // HSV saturation: rejects paper, grey and washed-out warm light
const MIN_MARGIN = 50; // how far red must sit above the brighter of green/blue, 0-255
const HUE_TOLERANCE = 18; // degrees either side of pure red
const HUE_SPREAD = HUE_TOLERANCE / 60; // |g - b| allowed, as a fraction of (max - min)

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

/**
 * True for pixels that look like red-pen ink rather than paper, skin, wood or a black pen.
 * Red must lead the other channels by a real margin, the colour must be saturated and bright
 * enough to be ink on paper, and the hue must sit within HUE_TOLERANCE of pure red - which is
 * what keeps warm paper, skin (hue ~25-40 degrees) and orange lamplight out.
 */
export function isRedInk(r: number, g: number, b: number): boolean {
  if (r <= g || r <= b) return false; // red channel must be the maximum
  if (r < MIN_VALUE * 255) return false; // too dark: black ink or shadow
  const delta = r - (g < b ? g : b); // r is the max, so this is the HSV chroma
  if (delta < MIN_SATURATION * r) return false; // too grey: paper, pencil, highlights
  if (r - (g > b ? g : b) < MIN_MARGIN) return false; // not clearly redder than it is warm
  return Math.abs(g - b) <= delta * HUE_SPREAD; // hue within +/- HUE_TOLERANCE of 0 degrees
}

/**
 * Fraction of pixels reading as red ink inside the centred `guideFraction` of the frame.
 * Samples a ~240px-wide copy on a single canvas that is reused across calls.
 */
export function detectRedInk(source: RedInkSource, guideFraction = 1): { ratio: number } {
  const isVideo = "videoWidth" in source;
  const sw = isVideo ? source.videoWidth : source.width;
  const sh = isVideo ? source.videoHeight : source.height;
  if (!sw || !sh) return { ratio: 0 };

  const fraction = Math.min(1, Math.max(0.1, guideFraction));
  const cropW = Math.max(1, Math.round(sw * fraction));
  const cropH = Math.max(1, Math.round(sh * fraction));
  const w = Math.max(1, Math.min(SAMPLE_WIDTH, cropW));
  const h = Math.max(1, Math.round((cropH / cropW) * w));

  scratch ??= document.createElement("canvas");
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;
  scratchCtx ??= scratch.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!scratchCtx) return { ratio: 0 };

  try {
    scratchCtx.drawImage(source, Math.round((sw - cropW) / 2), Math.round((sh - cropH) / 2), cropW, cropH, 0, 0, w, h);
    const { data } = scratchCtx.getImageData(0, 0, w, h);
    let hits = 0;
    for (let p = 0; p < data.length; p += 4) {
      if (isRedInk(data[p], data[p + 1], data[p + 2])) hits++;
    }
    return { ratio: hits / (w * h) };
  } catch {
    return { ratio: 0 }; // a not-yet-ready video frame must never break the preview
  }
}
