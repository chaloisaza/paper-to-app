// Hard spend cap. Every run's usage is priced, added up and written to .budget.json so the
// ceiling survives a restart. Once the cap is reached the server stops calling the API and
// replays a recording instead - the kiosk keeps working, it just stops costing money.

import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BudgetState, Usage } from "../shared/protocol.ts";

const STATE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.budget.json");

/** Dollars per million tokens, by model-id prefix. Longest matching prefix wins. */
const PRICES: readonly { prefix: string; in: number; out: number }[] = [
  { prefix: "claude-fable-5", in: 10, out: 50 },
  { prefix: "claude-mythos-5", in: 10, out: 50 },
  { prefix: "claude-opus-5", in: 5, out: 25 },
  { prefix: "claude-opus-4-8", in: 5, out: 25 },
  { prefix: "claude-opus-4-7", in: 5, out: 25 },
  { prefix: "claude-opus-4-6", in: 5, out: 25 },
  { prefix: "claude-sonnet-5", in: 2, out: 10 },
  { prefix: "claude-sonnet-4-6", in: 3, out: 15 },
  { prefix: "claude-haiku-4-5", in: 1, out: 5 },
];

// An unrecognised model is billed at the dearest known rate. For a ceiling, guessing high is
// the safe direction to be wrong in.
const DEAREST = PRICES.reduce((a, b) => (b.out > a.out ? b : a));

/** Held back so the last affordable run cannot overshoot the cap. Roughly one Fable run. */
const MIN_RUN_USD = 0.3;

function parseCap(raw: string | undefined): number | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return 5;
  if (value === "off" || value === "none" || value === "unlimited") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
}

/** null means no cap. */
const CAP_USD = parseCap(process.env.BUDGET_USD);

interface Persisted {
  spentUsd: number;
  runs: number;
  since: string;
}

// A ledger we cannot read must fail closed. Losing track of what has been spent and then happily
// spending again is the one failure this whole module exists to prevent, so an unreadable file
// stops the API calls until a human looks at it. A file that simply isn't there yet is not that.
let unreadable = false;

function load(): Persisted {
  const fresh: Persisted = { spentUsd: 0, runs: 0, since: new Date().toISOString() };
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<Persisted>;
    const spentUsd = Number(raw.spentUsd);
    const runs = Number(raw.runs);
    return {
      spentUsd: Number.isFinite(spentUsd) && spentUsd >= 0 ? spentUsd : 0,
      runs: Number.isFinite(runs) && runs > 0 ? Math.floor(runs) : 0,
      since: typeof raw.since === "string" && raw.since ? raw.since : fresh.since,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      unreadable = true;
      console.error(`[budget] ${STATE_FILE} could not be read, so no API calls will be made.`);
      console.error("[budget] Delete that file to start the running total over from zero.");
    }
    return fresh;
  }
}

const state = load();

const round = (usd: number): number => Math.round(usd * 1e4) / 1e4;
let writing: Promise<void> = Promise.resolve();

// Written to a sibling file and renamed into place: `rename` within one filesystem is atomic, so a
// crash (or the kiosk supervisor restarting the server) can never leave a half-written total behind.
function persist(): Promise<void> {
  const snapshot = { ...state, spentUsd: round(state.spentUsd), capUsd: CAP_USD };
  const temp = `${STATE_FILE}.tmp`;
  writing = writing
    .then(async () => {
      await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`);
      await rename(temp, STATE_FILE);
    })
    .catch((err: unknown) => {
      console.warn("[budget] could not save the running total:", err instanceof Error ? err.message : err);
    });
  return writing;
}

function priceFor(model: string): { in: number; out: number } {
  let best: (typeof PRICES)[number] | null = null;
  for (const price of PRICES) {
    if (model.startsWith(price.prefix) && (!best || price.prefix.length > best.prefix.length)) best = price;
  }
  return best ?? DEAREST;
}

export function costOf(model: string, usage: Usage): number {
  const price = priceFor(model);
  return (usage.inputTokens * price.in + usage.outputTokens * price.out) / 1_000_000;
}

/** True while there is room for one more run. Always true when there is no cap. */
export const canAfford = (): boolean =>
  !unreadable && (CAP_USD === null || state.spentUsd + MIN_RUN_USD <= CAP_USD);

export const budgetState = (): BudgetState => ({
  capUsd: CAP_USD,
  spentUsd: round(state.spentUsd),
  runs: state.runs,
  canAfford: canAfford(),
});

/** Adds one run to the total and saves it. A run with no usage (error, abort) costs nothing here. */
export async function recordSpend(model: string, usage: Usage | null): Promise<number> {
  if (!usage) return 0;
  const usd = costOf(model, usage);
  state.spentUsd += usd;
  state.runs += 1;
  await persist();
  return usd;
}

export const capLabel = (): string => (CAP_USD === null ? "no cap" : `$${CAP_USD.toFixed(2)} cap`);
