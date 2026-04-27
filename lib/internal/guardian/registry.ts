/**
 * Guardian status registry: a process-global record of the
 * last outcome of each registered guardian.
 *
 * Diagnostic aid for the `/guardian-status` command. When a
 * user reports that gates have stopped firing, the registry
 * answers "did the guardian even run for the last bash
 * command, and if so what did it decide?".
 *
 * Stored on `globalThis` via `Symbol.for` so a single
 * registry is shared across independently-loaded extension
 * packages: guardians registered from `agentic-harness.pi`
 * and from downstream packages (e.g. `joel.gerber.pi`'s
 * World guardians) all show up in one panel.
 *
 * State is per-process: lost on `/reload` or restart, which
 * is the right scope for a debug aid.
 */

const REGISTRY_KEY = Symbol.for("pi:guardian-registry");

/**
 * The reason a guardian short-circuited before reaching
 * `review`. Each value maps to one of the guard clauses in
 * `registerGuardian`'s tool_call handler.
 */
export type SkipReason = "no-ui" | "bypassed" | "detect-miss" | "parse-null";

/**
 * What the guardian did on its last invocation.
 *
 * - `allowed`: review returned ALLOW (undefined).
 * - `blocked`: review returned a block result.
 * - `rewritten`: review returned a rewrite. The rewrite
 *   string itself is omitted; only the fact is recorded.
 * - `skipped`: short-circuited before review for the given
 *   reason.
 */
export type GuardianOutcome =
	| { kind: "allowed" }
	| { kind: "blocked"; reason: string }
	| { kind: "rewritten" }
	| { kind: "skipped"; why: SkipReason };

/** A single entry in the registry. */
export interface GuardianStatus {
	/** Stable display name (e.g. "commit", "pr", "shopify-world-submit"). */
	name: string;
	/** Outcome of the most recent invocation, if any. */
	lastOutcome?: GuardianOutcome;
	/** When the most recent invocation completed. */
	lastCalledAt?: Date;
}

type Registry = Map<string, GuardianStatus>;
type GlobalRegistry = Record<symbol, Registry | undefined>;

function getRegistry(): Registry {
	const slot = globalThis as GlobalRegistry;
	const existing = slot[REGISTRY_KEY];
	if (existing) return existing;
	const fresh: Registry = new Map();
	slot[REGISTRY_KEY] = fresh;
	return fresh;
}

/**
 * Seed an entry for `name` so it shows up in `/guardian-status`
 * before any tool_call has fired. Idempotent: re-registering an
 * existing name is a no-op (preserves the previous outcome).
 */
export function register(name: string): void {
	const registry = getRegistry();
	if (!registry.has(name)) registry.set(name, { name });
}

/**
 * Record the outcome of a guardian's most recent invocation.
 * Auto-creates the entry if `register` was never called.
 */
export function record(name: string, outcome: GuardianOutcome): void {
	const registry = getRegistry();
	registry.set(name, {
		name,
		lastOutcome: outcome,
		lastCalledAt: new Date(),
	});
}

/**
 * Snapshot of all registry entries, sorted by name. Returned
 * value is independent of registry state: callers may keep it
 * across calls without worrying about mutation.
 */
export function list(): GuardianStatus[] {
	const registry = getRegistry();
	return [...registry.values()]
		.map((entry) => ({ ...entry }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Reset the registry. Intended for tests and `/reload` semantics. */
export function clear(): void {
	getRegistry().clear();
}
