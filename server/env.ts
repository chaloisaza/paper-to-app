// Must be the first import of server/index.ts.
// The project's .env wins over variables inherited from the shell: `node --env-file` never
// overrides an existing variable, so a stale ANTHROPIC_API_KEY exported in a shell profile
// would silently shadow the key in .env.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

if (existsSync(envPath)) {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(envPath, "utf8")))) {
    if (value === undefined || value.trim() === "") continue;
    if (process.env[name] !== undefined && process.env[name] !== value) {
      console.log(`[env] ${name}: using the value from .env (overrides the one inherited from the shell)`);
    }
    process.env[name] = value.trim();
  }
}
