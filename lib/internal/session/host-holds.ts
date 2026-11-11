/**
 * Which host holds a conversation, for the readers that would otherwise
 * judge it by the pid a record names.
 *
 * On 10 November the canary conversation moved into the background
 * host, and the readers that decide whether a session is lost still
 * looked at the pid its records named: an old plain pi's, gone, or a
 * crashed host's. Each read it dead, and the next step was to stamp it
 * died, drop it from the launcher's running list, or reopen it in plain
 * pi, a second writer on its log (K7's audit, 44dfd277).
 *
 * A host says what it holds in two places. Its list
 * (`hosts/<pid>-<start>.json`, lib/core/session/registry.ts) names what
 * it has open while its process runs. Its roster
 * (`host-rosters/<key>.json`, lib/core/session/roster.ts) names what it
 * keeps for resume, and outlives a crash or restart: the host takes
 * every conversation on it up again when it starts. So a conversation
 * on a roster is the host's even while the host is down, and nothing
 * else may open it, stamp it ended or forget it.
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import {
	parseRoster,
	type RosterEntry,
	rosterDir,
} from "../../core/session/roster.ts";
import { type Looking, liveHolder } from "./one-writer.ts";

/** A host holding a conversation. */
export interface HostHold {
	/** Its key, such as work-background. */
	readonly key: string;
	/** The realm it serves, which attaching to it names. */
	readonly realm: string;
	/** Open in a running host now, rather than only kept for its resume. */
	readonly open: boolean;
}

/** Where the lists and rosters are; the machine's unless a test sets them. */
export interface HoldsLooking extends Looking {
	readonly rosters?: string;
}

/** A host key's realm: the key without its kind. */
const KIND = /-(?:attended|background)$/;

const ROSTER_SUFFIX = ".json";

/**
 * Every conversation the rosters keep, by session id to host key, read
 * at once. A roster that can't be read keeps nothing here, as none is
 * evidence of a hold.
 */
export function rosterHolds(dir: string = rosterDir()): Map<string, string> {
	const holds = new Map<string, string>();
	for (const { key, entry } of keptEntries(dir))
		holds.set(entry.sessionId, key);
	return holds;
}

/**
 * The conversations the rosters keep that work in `folder` or below it,
 * by session id. A hosted conversation's folder is its own, not its host
 * process's, so `/proc` never shows it working there: a clone in a
 * quest's scratch folder would look unused while one sat open in it.
 */
export function conversationsIn(
	folder: string,
	dir: string = rosterDir(),
): string[] {
	const real = realOr(folder);
	return keptEntries(dir)
		.filter(({ entry }) => {
			const cwd = realOr(entry.cwd);
			return cwd === real || cwd.startsWith(real + sep);
		})
		.map(({ entry }) => entry.sessionId);
}

/** A path with its links resolved, or as given once it is gone. */
function realOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// Gone, or never made: compared as written.
		return path;
	}
}

/** Every roster's entries, each with the key of the host keeping it. */
function keptEntries(
	dir: string,
): { readonly key: string; readonly entry: RosterEntry }[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(ROSTER_SUFFIX));
	} catch {
		// No folder: no host has kept anything on this machine.
		return [];
	}
	const kept: { readonly key: string; readonly entry: RosterEntry }[] = [];
	for (const name of names) {
		const key = name.slice(0, -ROSTER_SUFFIX.length);
		let text: string;
		try {
			text = readFileSync(join(dir, name), "utf8");
		} catch {
			// Gone or mid-replacement: the next read finds it.
			continue;
		}
		for (const entry of parseRoster(text, key)?.sessions ?? []) {
			kept.push({ key, entry });
		}
	}
	return kept;
}

/** The hold a host key makes. */
export function holdOf(key: string, open: boolean): HostHold {
	return { key, realm: key.replace(KIND, ""), open };
}

/**
 * The host holding a conversation: open in a running host, else kept on
 * a roster for resume, else none.
 */
export async function hostHold(
	sessionId: string,
	looking: HoldsLooking = {},
): Promise<HostHold | undefined> {
	const live = await liveHolder(sessionId, looking);
	if (live) return holdOf(live.key, true);
	const key = rosterHolds(looking.rosters).get(sessionId);
	return key === undefined ? undefined : holdOf(key, false);
}

/**
 * The words that join a hosted conversation from a terminal here, as
 * mycelium's attach_here gives them. Realm and key are checked names and
 * the id a UUID, so they need no quoting.
 */
export function attachWords(hold: HostHold, sessionId: string): string[] {
	return [
		"mycelium",
		"--realm",
		hold.realm,
		"attach",
		"--host",
		hold.key,
		"--session",
		sessionId,
	];
}

/**
 * The exit code `mycelium attach --host` ends with when its host let the
 * conversation go back to plain pi, as a release does, rather than 0 for
 * any other leaving (mycelium's `hold::holder::RELEASED`).
 */
export const RELEASED_EXIT = 3;

/**
 * Set, to the exit code attach failed with, for the words a window
 * carries on as after its attach failed rather than being released; unset
 * after a release.
 */
export const ATTACH_FAILED_ENV = "PI_HOST_ATTACH_FAILED";

/**
 * The words a window runs to view a conversation `hold` holds. Should
 * attach end any way but 0, the window carries on as `after`: after a
 * release, with {@link ATTACH_FAILED_ENV} unset, and after a failure,
 * as when the host refused the attach, with it set to attach's exit code,
 * so the window stays rather than closing (QCXZEB's move in place, 11
 * November). Attach ending 0, as its person quitting does, ends them.
 * Each word stays a word of its own, so `--session` and the id still sit
 * side by side, which is how mycelium's node knows the window is the
 * conversation's.
 */
export function viewingWords(
	hold: HostHold,
	sessionId: string,
	after: readonly string[],
): string[] {
	const attach = attachWords(hold, sessionId);
	const run = attach.map((_, at) => `"\${${at + 1}}"`).join(" ");
	const script = [
		`${run}; s=$?`,
		`[ "$s" -eq 0 ] && exit 0`,
		`shift ${attach.length}`,
		`[ "$#" -gt 0 ] || exit "$s"`,
		`if [ "$s" -eq ${RELEASED_EXIT} ]; then unset ${ATTACH_FAILED_ENV}; else export ${ATTACH_FAILED_ENV}="$s"; fi`,
		`exec "$@"`,
	].join("; ");
	return ["sh", "-c", script, "sh", ...attach, ...after];
}

/** What a reader says of a conversation a host holds, and how to reach it. */
export function heldByHost(sessionId: string, hold: HostHold): string {
	const where = hold.open
		? `is open in the ${hold.key} host`
		: `is kept by the ${hold.key} host, which takes it up again as it starts`;
	return `Session ${sessionId} ${where}, so nothing else was opened on its log, which would give it a second writer. Reach it through its host, with the launcher's Go To or: ${attachWords(hold, sessionId).join(" ")}`;
}
