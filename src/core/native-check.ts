import { createRequire } from "node:module";

import type DB from "better-sqlite3";
import { SwitchboardError } from "./errors.js";

/**
 * better-sqlite3 is a native addon. Two subtleties this module handles:
 *   1. `require("better-sqlite3")` does NOT load the compiled `.node` — the addon
 *      is loaded lazily on first `new Database()`. So a real ABI check must
 *      actually CONSTRUCT a database, not just require the module.
 *   2. An ABI mismatch (`process.versions.modules` vs the compiled `.node`, e.g.
 *      after a `brew upgrade node`) throws `NODE_MODULE_VERSION`. We convert that
 *      into a clear `npm rebuild` remedy so `doctor`/the daemon report it instead
 *      of crashing with a raw stack trace before any command can run.
 */
type DatabaseCtor = new (path: string, opts?: unknown) => DB.Database;
let ctor: DatabaseCtor | undefined;

function loadCtor(): DatabaseCtor {
  if (ctor) return ctor;
  const require = createRequire(import.meta.url);
  ctor = require("better-sqlite3") as DatabaseCtor;
  return ctor;
}

/** Open a SQLite database, converting a native-load/ABI failure into a friendly remedy. */
export function openDatabase(dbPath: string): DB.Database {
  try {
    return new (loadCtor())(dbPath);
  } catch (err) {
    if (isNativeLoadError(err)) throw nativeModuleError(err);
    throw err; // an ordinary SQLite open error (bad path, perms, locked) — surface as-is
  }
}

/** Does this error come from loading/ABI-matching the native addon (vs a normal SQLite error)? */
function isNativeLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /NODE_MODULE_VERSION|compiled against a different|different Node\.js version|Could not locate the bindings|was compiled against|dlopen|symbol not found|image not found|mach-o|invalid ELF/i.test(
    msg,
  );
}

/**
 * Preflight for `doctor` and the daemon: force the native addon to load (it loads
 * lazily at construction, NOT at require) by opening an in-memory database, and
 * throw a friendly remedy if its ABI doesn't match the running Node.
 */
export function checkNativeModule(): void {
  openDatabase(":memory:").close();
}

function nativeModuleError(err: unknown): SwitchboardError {
  const msg = err instanceof Error ? err.message : String(err);
  const abiMismatch =
    /NODE_MODULE_VERSION|compiled against a different|different Node\.js version/i.test(msg);
  const remedy =
    `Run \`npm rebuild better-sqlite3\` with Node ${process.version} active ` +
    `(a Node major-version change after install requires a rebuild).`;
  // Scrub the raw NODE_MODULE_VERSION token from the appended detail — the remedy is the
  // actionable part, and CI asserts the raw native string never reaches the user.
  const detail = msg.replace(/NODE_MODULE_VERSION ?\d*/g, "a different module ABI");
  return new SwitchboardError(
    "native_module_error",
    abiMismatch
      ? `better-sqlite3 was built against a different Node.js ABI than the one now running (${process.version}). ${remedy}\n  ${detail}`
      : `Failed to load the better-sqlite3 native module. ${remedy}\n  ${detail}`,
    { cause: err },
  );
}
