import { CDN_CHART_URL, CDN_TAILWIND_URL, VENDOR_CHART_PATH, VENDOR_TAILWIND_PATH } from "../../shared/protocol";

const DOC_START = /<(?:!doctype|html)/i;
const SCRIPT_OR_DOC_END = /<script\b|<\/html\s*>/gi;
const isSpace = (ch: string) => ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f";

// Index just past the first </html> that sits outside script data (a "</html>" inside a JS string
// does not end the document), mirroring the tokenizer; -1 when there is none yet.
function docEnd(doc: string): number {
  let from = 0;
  for (;;) {
    SCRIPT_OR_DOC_END.lastIndex = from;
    const m = SCRIPT_OR_DOC_END.exec(doc);
    if (!m) return -1;
    if (m[0][1] === "/") return m.index + m[0].length;
    const close = doc.indexOf("</script", m.index + m[0].length);
    if (close < 0) return -1;
    from = close + "</script".length;
  }
}

/**
 * Clean document prefix of a raw model stream: chatter and a leading fence are dropped,
 * everything after the first </html> is cut. Prefix-stable: more input only ever appends.
 */
export function cleanHtmlStream(raw: string): string {
  const start = raw.search(DOC_START);
  if (start < 0) return "";
  const doc = raw.slice(start);
  const end = docEnd(doc);
  if (end >= 0) return doc.slice(0, end);

  // Hold back a tail that could still turn into a closing fence (whitespace, up to three backticks).
  let cut = doc.length;
  while (cut > 0 && isSpace(doc[cut - 1])) cut--;
  for (let ticks = 0; ticks < 3 && cut > 0 && doc[cut - 1] === "`"; ticks++) cut--;
  while (cut > 0 && isSpace(doc[cut - 1])) cut--;
  return doc.slice(0, cut);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Makes a generated app standalone: local vendor script URLs become their public CDN equivalents. */
export function exportHtml(html: string, assetOrigin: string): string {
  const origin = assetOrigin.replace(/\/+$/, "");
  const hosts = ["https?:\\/\\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::\\d+)?"];
  if (origin) hosts.unshift(escapeRe(origin));
  const swap = (out: string, path: string, cdn: string) =>
    out.replace(new RegExp(`(?:${hosts.join("|")})${escapeRe(path)}|(?<=["'=])${escapeRe(path)}`, "gi"), () => cdn);
  return swap(swap(html, VENDOR_TAILWIND_PATH, CDN_TAILWIND_URL), VENDOR_CHART_PATH, CDN_CHART_URL);
}

export function downloadHtml(html: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = /\.html?$/i.test(filename) ? filename : `${filename}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
