/**
 * What the `/guards` command was asked to do.
 */

import {
	GUARD_MODES,
	type GuardMode,
	readGuardMode,
} from "../../lib/guardian/index.ts";

/** A parsed `/guards` invocation. */
export type GuardsCommand =
	| { kind: "list" }
	| { kind: "reset" }
	| { kind: "set"; key: string; mode: GuardMode }
	| { kind: "error"; message: string };

/**
 * Read `/guards` arguments against the keys the policy knows.
 *
 * No arguments lists the guards; `reset` clears the session's
 * overrides; a key and a mode set one. An unknown key is refused
 * rather than stored, since a setting nothing reads is a typo that
 * would otherwise look like it worked.
 */
export function parseGuardsCommand(
	args: string,
	knownKeys: readonly string[],
): GuardsCommand {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return { kind: "list" };
	if (words.length === 1 && words[0] === "reset") return { kind: "reset" };
	if (words.length !== 2) {
		return {
			kind: "error",
			message: `Usage: /guards, /guards reset, or /guards <name|group|class|all> <${GUARD_MODES.join("|")}>`,
		};
	}
	const [key, mode] = words;
	if (!knownKeys.includes(key)) {
		return {
			kind: "error",
			message: `No guard, group or class is called ${key}. Known: ${knownKeys.join(", ")}`,
		};
	}
	// The former `report` is read as `off`, which does what it did, so
	// fingers that learned it still get what they meant.
	const read = readGuardMode(mode);
	if (!read) {
		return {
			kind: "error",
			message: `${mode} is not a mode. Use one of ${GUARD_MODES.join(", ")}.`,
		};
	}
	return { kind: "set", key, mode: read };
}

/**
 * Completions for the argument text typed so far. Each is the whole
 * argument text, since the completion replaces what was typed.
 */
export function guardsCompletions(
	argumentText: string,
	knownKeys: readonly string[],
): string[] {
	const words = argumentText.trimStart().split(/\s+/);
	if (words.length <= 1) {
		const current = words[0] ?? "";
		return [...knownKeys, "reset"].filter((key) => key.startsWith(current));
	}
	const [key, current = ""] = words;
	return GUARD_MODES.filter((mode) => mode.startsWith(current)).map(
		(mode) => `${key} ${mode}`,
	);
}
