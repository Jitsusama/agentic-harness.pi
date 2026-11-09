/**
 * Guardian status registry: shared declarations and conversation-owned
 * last outcomes, with the original process-global record on plain pi.
 *
 * Diagnostic aid for the `/guards` command. When a
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
 * Hosted outcomes are kept in session slots, so one conversation never
 * displays another's last invocation. They survive reload and are released
 * with the conversation, while registered names remain shared.
 */

import {
	hosted,
	type SessionRef,
	sessionSlot,
} from "../../core/session/index.ts";

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

function outcomes(ref?: SessionRef): Registry {
	return sessionSlot(
		"pi:guardian-outcomes",
		ref,
		() => new Map<string, GuardianStatus>(),
	);
}

/**
 * Seed an entry for `name` so it shows up in `/guards`
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
	register(name);
	const registry = hosted() ? outcomes() : getRegistry();
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
export function list(ref?: SessionRef): GuardianStatus[] {
	const registry = getRegistry();
	const local = hosted() ? outcomes(ref) : registry;
	return [...registry.values()]
		.map((entry) => local.get(entry.name) ?? { name: entry.name })
		.map((entry) => ({ ...entry }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Reset the registry. Intended for tests and `/reload` semantics. */
export function clear(): void {
	if (hosted()) outcomes().clear();
	else getRegistry().clear();
}
