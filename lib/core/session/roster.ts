/**
 * The durable list of conversations each realm-kind host holds for resume.
 *
 * HostRegistry files name a host process, so they vanish from the answer
 * the moment a host crashes. A roster names the stable host key instead
 * and outlives every restart: a host stopping or being killed leaves its
 * holds in place, and only a deliberate close or release removes one.
 * Readers outside the host import this file directly; it is not part of
 * the public barrel.
 */
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { stateDir } from "../../internal/paths.ts";
import { isRecord } from "../../internal/record.ts";

/** One conversation a host keeps for resume, named by pi's stable id. */
export interface RosterEntry {
	readonly sessionId: string;
	readonly file: string;
	readonly cwd: string;
	readonly attended: boolean;
	readonly quest?: string;
	readonly since: string;
	/**
	 * The environment the engine derived for it at open, such as its
	 * experiment arm, replayed as it stands at every resume, since a
	 * resume has no request to derive it from again. Never a credential:
	 * keys come from the host per request. Absent reads as none.
	 */
	readonly launch?: Readonly<Record<string, string>>;
}

/** A host key's whole roster, rewritten atomically on every change. */
export interface Roster {
	readonly v: 1;
	readonly key: string;
	readonly sessions: readonly RosterEntry[];
}

/** Whether any host holds a conversation; doubt is never unheld. */
export type HeldStatus = "held" | "unheld" | "unknown";

const ROSTER_SUFFIX = ".json";
// A realm name, as lib/internal/realm.ts holds it, then -attended or -background.
const KEY = /^[a-z0-9-]{1,64}-(?:attended|background)$/;
/** An environment variable's name, as a POSIX shell takes one. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The folder every roster lives in; the host creates it before any hold. */
export function rosterDir(): string {
	return stateDir("host-rosters");
}

/** The roster for one realm-kind key, such as work-attended. */
export function rosterPath(key: string, dir = rosterDir()): string {
	if (!KEY.test(key)) throw new Error("Host key must be a realm and a kind");
	return join(dir, `${key}${ROSTER_SUFFIX}`);
}

/** Parse a roster, refusing anything a reaper could misread as empty. */
export function parseRoster(text: string, key: string): Roster | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// Malformed JSON is not a roster; the caller treats it as unknown.
		return undefined;
	}
	if (!isRecord(value) || value.v !== 1 || value.key !== key) return undefined;
	const sessions = value.sessions;
	if (!Array.isArray(sessions) || !sessions.every(isEntry)) return undefined;
	const ids = new Set(sessions.map((entry) => entry.sessionId));
	if (ids.size !== sessions.length) return undefined;
	return { v: 1, key, sessions };
}

/**
 * Whether a conversation is held for resume on this machine, across a
 * host's crash or restart. Only a complete read of every roster that
 * finds it nowhere answers unheld. A named host key whose roster is
 * missing, any unreadable or malformed roster, or no rosters at all
 * answer unknown, unless another roster holds it.
 */
export async function heldSessionStatus(
	sessionId: string,
	options: { readonly dir?: string; readonly hostKey?: string } = {},
): Promise<HeldStatus> {
	const dir = options.dir ?? rosterDir();
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith(ROSTER_SUFFIX));
	} catch {
		// No folder means no host ever recorded a hold here, or it was
		// removed: neither proves a hosted conversation was closed.
		return "unknown";
	}
	let doubt = names.length === 0;
	if (
		options.hostKey !== undefined &&
		!names.includes(`${options.hostKey}${ROSTER_SUFFIX}`)
	)
		doubt = true;
	for (const name of names) {
		const key = name.slice(0, -ROSTER_SUFFIX.length);
		let roster: Roster | undefined;
		try {
			roster = KEY.test(key)
				? parseRoster(await readFile(join(dir, name), "utf8"), key)
				: undefined;
		} catch {
			// Unreadable now, perhaps mid-replacement: doubt, not absence.
			roster = undefined;
		}
		if (!roster) {
			doubt = true;
			continue;
		}
		if (roster.sessions.some((entry) => entry.sessionId === sessionId))
			return "held";
	}
	return doubt ? "unknown" : "unheld";
}

function isEntry(value: unknown): value is RosterEntry {
	if (!isRecord(value)) return false;
	const { sessionId, file, cwd, attended, quest, since, launch } = value;
	return (
		typeof sessionId === "string" &&
		UUID.test(sessionId) &&
		typeof file === "string" &&
		isAbsolute(file) &&
		typeof cwd === "string" &&
		isAbsolute(cwd) &&
		typeof attended === "boolean" &&
		(quest === undefined || (typeof quest === "string" && quest.length > 0)) &&
		typeof since === "string" &&
		!Number.isNaN(Date.parse(since)) &&
		(launch === undefined || isLaunch(launch))
	);
}

function isLaunch(value: unknown): value is Record<string, string> {
	return (
		isRecord(value) &&
		Object.entries(value).every(
			([name, setting]) => ENV_NAME.test(name) && typeof setting === "string",
		)
	);
}
