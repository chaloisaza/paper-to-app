import type Anthropic from "@anthropic-ai/sdk";
import type { GenerateRequest } from "../shared/protocol.ts";

type ContentBlock = Anthropic.Beta.BetaContentBlockParam;
type ImageBlock = Anthropic.Beta.BetaImageBlockParam;

const FALLBACK_ORIGIN = "http://localhost:8787";

const SYSTEM_PROMPT = `You turn webcam photos of hand-drawn sketches into working web apps. The sketch might be an app screen, a dashboard, a tool, or a game level; whatever it is, the person wants to use or play it a few seconds from now. Expect glare, skew and messy handwriting; read the page generously, the way a teammate reads a whiteboard.

The sketch uses ordinary wireframe shorthand: a box with an X is an image, squiggly lines are text, a small labelled box is a button, stacked rows are a list or table, axes or a zigzag are a chart, a circle is an avatar. Handwritten labels are real copy. Work out what the app is for and build that app, not a picture of the drawing: the sketch gives intent and rough layout; spacing, colour and polish are yours.

Make it real. Every control does something (forms add items, tabs switch, filters filter, charts render) and the data is plausible and specific, never lorem ipsum. A drawn game is playable: keyboard and touch controls, a score, a way to win or lose, and the level laid out the way it was drawn. Call preventDefault() on every key your app uses, and start a game as soon as the page loads rather than behind a start screen. The page runs in a sandboxed iframe, so keep state in memory: no localStorage, cookies or network calls. Draw images as inline SVG or gradients.

Red ink is never UI. It is the person's edit instructions: a red circle or arrow marks what to change, red writing says how, a red strike-through means remove. Apply it; don't draw it.

Reply with one complete HTML document and nothing else, starting at <!DOCTYPE html>: no markdown fences, no commentary. Inline the CSS and JS. The only external resources allowed are these two script tags, used exactly as written: <script src="{ORIGIN}/vendor/tailwind.js"></script> in <head>, and <script src="{ORIGIN}/vendor/chart.js"></script> if you need charts. Put markup before your own script (last in <body>) so the page paints while streaming, and keep it compact, roughly 300 lines.`;

/** The http(s) origin of `assetOrigin`, or null when it is not one. */
export function parseOrigin(assetOrigin: unknown): string | null {
  if (typeof assetOrigin !== "string") return null;
  try {
    const url = new URL(assetOrigin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(assetOrigin: unknown): string {
  return SYSTEM_PROMPT.replaceAll("{ORIGIN}", parseOrigin(assetOrigin) ?? FALLBACK_ORIGIN);
}

// The client always sends JPEG; sniffing the base64 header keeps an uploaded PNG/WebP from failing the whole run.
function mediaType(data: string): Anthropic.Beta.BetaBase64ImageSource["media_type"] {
  if (data.startsWith("iVBOR")) return "image/png";
  if (data.startsWith("UklGR")) return "image/webp";
  if (data.startsWith("R0lGOD")) return "image/gif";
  return "image/jpeg";
}

const image = (data: string): ImageBlock => ({
  type: "image",
  source: { type: "base64", media_type: mediaType(data), data },
});

const text = (value: string): ContentBlock => ({ type: "text", text: value });

export function buildUserContent(req: GenerateRequest): ContentBlock[] {
  const note = req.instruction?.trim() ? `\nTyped note: "${req.instruction.trim()}"` : "";
  const html = req.currentHtml ?? "";

  if (req.mode === "create") {
    return [image(req.image ?? ""), text(`Here's my sketch. Build the app.${note}`)];
  }

  if (req.mode === "iterate") {
    const which = req.prevImage
      ? "Apply only the red marks that are new since the previous photo; earlier ones are already done."
      : "Red marks the current app already reflects are done; apply the rest.";
    return [
      ...(req.prevImage ? [image(req.prevImage), text("Previous photo.")] : []),
      text(`Current app:\n${html}`),
      image(req.image ?? ""),
      text(
        `New photo. If it is the same paper with red-pen notes: ${which} Keep everything else as it is and return the full updated document. If it is a different sketch altogether, set the current app aside and build the new sketch from scratch.${note}`,
      ),
    ];
  }

  return [
    text(`Current app:\n${html}`),
    text(
      `This app threw a runtime error in the browser: ${req.runtimeError ?? "unknown error"}. Fix that error, change nothing else, and return the full updated document.`,
    ),
  ];
}
