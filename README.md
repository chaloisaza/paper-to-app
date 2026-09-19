# Paper→App

Sketch an app on paper. Hold it up to your webcam. Press **Space**.
Claude Fable 5.1 reads the drawing and streams a *working* app into the page — real buttons, real charts, playable games. Then grab a **red pen**, circle something, write what you want ("sort by price", "make this a chart", "add an enemy here"), hold it up again, and the app updates itself.

Built in four hours at a Claude Community event · **Delight** track · powered by `claude-fable-5-1`.

## Run it

```bash
pnpm install
cp .env.example .env        # then paste your key after ANTHROPIC_API_KEY=
pnpm dev                    # web on http://localhost:5173, API on :8787
```

Demo mode (one process, no dev proxy in the streaming path):

```bash
pnpm demo                   # builds, then serves everything on http://localhost:8787
```

The project's `.env` always wins over an `ANTHROPIC_API_KEY` inherited from your shell.

## Keys

| Key | Action |
|---|---|
| `Space` | 3-2-1 countdown, then capture the sharpest of 4 frames |
| `M` | mirror / un-mirror the camera preview (captures are never mirrored) |
| `←` `→` | walk through versions in the filmstrip |
| `C` | code drawer — watch the HTML stream in |
| `D` | download the current version as one standalone `.html` file |
| `N` | new app (next capture starts from scratch instead of iterating) |
| `Esc` | cancel a generation |
| `Shift`+`R` | replay a recorded run (offline-safe demo insurance) |

No webcam? Use **Upload** or click one of the bundled sketches in `public/samples/`.

## How it works

```
webcam frame ──► crop to guide, keep sharpest, JPEG ──► POST /api/generate
                                                          │
                     Express (keeps the API key)          ▼
                     client.beta.messages.stream({ model: "claude-fable-5-1",
                       thinking: { type: "adaptive", display: "summarized" },
                       output_config: { effort }, fallbacks: "default", … })
                                                          │  NDJSON: thinking / text / done
                                                          ▼
   sandboxed <iframe sandbox="allow-scripts …">  ◄── postMessage chunks ──  React app
   a tiny receiver document.write()s every chunk, so the browser's own
   streaming parser paints the app while Claude is still writing it
```

- **Stateless requests.** Every call carries what the model needs: the new photo, the previous photo (so it can tell which red marks are new), and the current app's HTML. The model always returns one complete HTML document — no patch format to go wrong on stage.
- **Red ink is never UI.** The system prompt teaches the model that red marks are edit instructions: apply them, don't draw them.
- **Progressive render without flicker.** The iframe's `srcdoc` is set once to a receiver; chunks are written with `document.write`, scripts run once, in order, when they arrive. No `allow-same-origin`, so generated code can't touch the host page.
- **Wi-Fi-proof.** Tailwind and Chart.js are served from `public/vendor/`; downloads rewrite them to public CDNs so exported apps work anywhere.
- **Record / replay.** `RECORD=1 pnpm dev` saves every run to `recordings/`. `Shift+R` replays one through the exact same streaming UI.
- **Self-healing.** If the generated app throws, the error is forwarded out of the sandbox and one click sends it back to Claude: "fix this, change nothing else."
- **Refusal fallback** is on by default (`fallbacks: "default"`); any optional beta the key doesn't accept is dropped automatically. `PAPER_MODEL=claude-opus-5 FAST_MODE=1` is the latency escape hatch.

## Layout

```
shared/protocol.ts     wire contract (request + NDJSON events)
server/                Express app · Claude call · prompts · record/replay
src/                   React UI: CameraCapture · PreviewFrame · Filmstrip · CodeDrawer · …
public/vendor/         Tailwind + Chart.js, served locally
public/samples/        bundled sketches (one click instead of a capture)
recordings/            saved runs for replay
```
