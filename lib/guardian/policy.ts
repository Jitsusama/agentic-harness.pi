/**
 * The guard policy: one answer to "what does this guard do now?".
 *
 * Every guard in the package, and in any package that joins, declares
 * a name, a class and a default mode here. A mode is resolved from
 * three layers, most recent intent first: an override set in this
 * session, then the package config, then the guard's own default.
 * Within a layer the most specific key wins: the guard's name, then
 * one of its groups, then its class, then `all`.
 *
 * A guard can follow others instead of having a default of its own.
 * The rules that split chained git commands exist so a panel can
 * review one command at a time, so with every panel they serve in
 * report they have nothing to protect and report too.
 *
 * State lives on `globalThis` under a `Symbol.for` key, so
 * independently loaded extensions (and downstream packages loading
 * their own copy of this module) all read the same policy.
 */

/** What a guard does when it fires. */
export type GuardMode = "off" | "report" | "block";

/**
 * What a guard is for.
 *
 * - approval: shows content a person may want to read before it lands.
 * - redirect: refuses with a way to try again.
 * - safety: protects something that cannot be brought back.
 */
export type GuardClass = "approval" | "redirect" | "safety";

/** Where a resolved mode came from. */
export type ModeSource = "session" | "config" | "default" | "follows";

/** A guard as its owner declares it. */
export interface GuardDeclaration {
	/** Unique name, used on the command line and in config. */
	readonly name: string;
	readonly class: GuardClass;
	/** One line saying what it guards. */
	readonly description: string;
	/** Mode when nothing more specific says otherwise. */
	readonly defaultMode: GuardMode;
	/** Group keys that also select this guard, e.g. `git`. */
	readonly groups?: readonly string[];
	/**
	 * Guards this one exists to serve. With no setting of its own it
	 * blocks when any of them blocks and reports otherwise.
	 */
	readonly follows?: readonly string[];
}

/** A guard with its mode resolved. */
export interface ResolvedGuard {
	readonly declaration: GuardDeclaration;
	readonly mode: GuardMode;
	readonly source: ModeSource;
}

/** Keys mapped to modes, as one layer of settings. */
export type ModeSettings = Readonly<Record<string, GuardMode>>;

/** Every mode, in order of how much a guard intervenes. */
export const GUARD_MODES: readonly GuardMode[] = ["off", "report", "block"];

/** The key that selects every guard. */
export const ALL_GUARDS = "all";

interface PolicyState {
	guards: Map<string, GuardDeclaration>;
	session: Record<string, GuardMode>;
	config: Record<string, GuardMode>;
}

const POLICY_KEY = Symbol.for("pi:guard-policy");

type GlobalPolicy = Record<symbol, PolicyState | undefined>;

function policy(): PolicyState {
	const global = globalThis as GlobalPolicy;
	let state = global[POLICY_KEY];
	if (!state) {
		state = { guards: new Map(), session: {}, config: {} };
		global[POLICY_KEY] = state;
	}
	return state;
}

/** Whether a value is one of the guard modes. */
export function isGuardMode(value: unknown): value is GuardMode {
	return GUARD_MODES.includes(value as GuardMode);
}

/**
 * Declare a guard. Declaring the same name again replaces the
 * declaration, so a reloaded extension does not leave a stale one.
 */
export function declareGuard(declaration: GuardDeclaration): void {
	policy().guards.set(declaration.name, declaration);
}

/** Every declared guard with its mode, in name order. */
export function listGuards(): ResolvedGuard[] {
	return [...policy().guards.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((declaration) => resolve(declaration, new Set()));
}

/**
 * The mode a guard is in now. An undeclared name resolves from
 * whatever settings name it, falling back to block: a guard nobody
 * declared is one whose owner predates the policy, and it should go on
 * doing what it did.
 */
export function guardMode(name: string): GuardMode {
	return resolveName(name, new Set()).mode;
}

/** Every key a setting may use: names, groups, classes and `all`. */
export function selectorKeys(): string[] {
	const keys = new Set<string>([ALL_GUARDS, "approval", "redirect", "safety"]);
	for (const guard of policy().guards.values()) {
		keys.add(guard.name);
		for (const group of guard.groups ?? []) keys.add(group);
	}
	return [...keys].sort();
}

/** Set a session override for a guard, group, class or `all`. */
export function setSessionMode(key: string, mode: GuardMode): void {
	policy().session[key] = mode;
}

/** The session's overrides, for saving. */
export function sessionModes(): ModeSettings {
	return { ...policy().session };
}

/** Replace the session's overrides, as when restoring a saved session. */
export function restoreSessionModes(modes: ModeSettings): void {
	policy().session = { ...modes };
}

/** Replace the modes the package config sets. */
export function setConfiguredModes(modes: ModeSettings): void {
	policy().config = { ...modes };
}

function resolveName(name: string, seen: Set<string>): ResolvedGuard {
	const declaration = policy().guards.get(name) ?? {
		name,
		class: "redirect",
		description: "",
		defaultMode: "block",
	};
	return resolve(declaration, seen);
}

function resolve(
	declaration: GuardDeclaration,
	seen: Set<string>,
): ResolvedGuard {
	const keys = keysOf(declaration);
	const state = policy();
	for (const [source, layer] of [
		["session", state.session],
		["config", state.config],
	] as const) {
		for (const key of keys) {
			const mode = layer[key];
			if (mode) return { declaration, mode, source };
		}
	}
	const followed = (declaration.follows ?? []).filter((n) => !seen.has(n));
	if (followed.length > 0) {
		const next = new Set([...seen, declaration.name]);
		const blocks = followed.some(
			(name) => resolveName(name, next).mode === "block",
		);
		return {
			declaration,
			mode: blocks ? "block" : "report",
			source: "follows",
		};
	}
	return { declaration, mode: declaration.defaultMode, source: "default" };
}

/** A guard's selector keys, most specific first. */
function keysOf(declaration: GuardDeclaration): string[] {
	return [
		declaration.name,
		...(declaration.groups ?? []),
		declaration.class,
		ALL_GUARDS,
	];
}

/**
 * Read the `guards` section of the package config.
 *
 * Shaped for `getSection`: `undefined` means no section and parses to
 * no settings. A mode that is not one of the three is refused rather
 * than ignored, so a typo does not quietly leave a guard blocking.
 */
export function parseGuardSection(
	value: unknown,
): { ok: true; value: ModeSettings } | { ok: false; error: string } {
	if (value === undefined) return { ok: true, value: {} };
	if (!isRecord(value)) return { ok: false, error: "must be an object" };
	const modes = value.modes;
	if (modes === undefined) return { ok: true, value: {} };
	if (!isRecord(modes)) return { ok: false, error: "modes must be an object" };
	const parsed: Record<string, GuardMode> = {};
	for (const [key, mode] of Object.entries(modes)) {
		if (!isGuardMode(mode)) {
			return {
				ok: false,
				error: `modes.${key} must be one of ${GUARD_MODES.join(", ")}`,
			};
		}
		parsed[key] = mode;
	}
	return { ok: true, value: parsed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
