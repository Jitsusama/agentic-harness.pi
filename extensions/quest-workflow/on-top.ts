/**
 * What Joel put on top: a few quests, why, and until when, said to
 * every session as it next works and counted as each one reads it.
 *
 * His wish of 11 November 2026 was one command that puts a few things
 * on top and tells every agent. Telling them with a hold would wake
 * each idle session for a turn of its own, about 80 at once, many of
 * them cold. Instead the orchestrator writes `top.json` beside the
 * launcher's other state, and each session reads it as a standing
 * context (lib/prompt): frozen into the prompt at its first turn, and
 * said once as a message at its next turn after a change, so no turn
 * is spent on it and no cache is rewritten. A parked session hears it
 * when it wakes. Each session that reads a top leaves its id in a
 * folder named for it, and the count of those is the receipt.
 *
 * The file:
 *
 *   {"quests": [{"id": "QEST-…", "title": "Deploy v3"}],
 *    "why": "his words", "until": "2026-11-20" | null,
 *    "at": "<ISO>", "by": "joel"}
 *
 * `until` is the last day it holds, local; null holds until he takes
 * it down. A file that doesn't parse, as one half written may not,
 * leaves the last one read standing.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../lib/internal/record.ts";
import {
	registerStandingContext,
	type StandingContextWording,
} from "../../lib/prompt/index.ts";

const LABEL = "[On top]";

/** How what's on top reads in the prompt and when it changes. */
export const ON_TOP: StandingContextWording = {
	customType: "on-top",
	inPrompt: (text) => `\n\n${LABEL} ${text}`,
	changed: (text) =>
		text === null
			? `${LABEL} Now: nothing is on top. This supersedes what was on top earlier.`
			: `${LABEL} Now: ${text} This supersedes what was on top earlier.`,
};

/** What is on top, as the file holds it. */
export interface OnTop {
	readonly quests: readonly { readonly id: string; readonly title?: string }[];
	readonly why: string;
	/** The last local day it holds, `YYYY-MM-DD`, or null for until taken down. */
	readonly until: string | null;
	readonly at: string;
	readonly by: string;
}

/** Where a reader finds the top and leaves its read. */
export interface OnTopPlaces {
	readonly file: string;
	readonly reads: string;
	/** The reading session's id, or empty when it has none yet. */
	readonly session: () => string;
	readonly now: () => number;
	readonly zone?: string;
}

/** The file the orchestrator writes, beside the launcher's other state. */
export function onTopFile(
	env: Readonly<Record<string, string | undefined>> = process.env,
	home = homedir(),
): string {
	return join(missionFolder(env, home), "top.json");
}

/** The folder of reads, a folder a top, a file a session. */
export function onTopReads(
	env: Readonly<Record<string, string | undefined>> = process.env,
	home = homedir(),
): string {
	return join(missionFolder(env, home), "top-reads");
}

/**
 * What a session is told is on top, read again only when the file
 * changes, and its read left once a top.
 */
export function onTopReader(places: OnTopPlaces): () => string | null {
	const zone = places.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	let mtime: number | undefined;
	let top: OnTop | null = null;
	return () => {
		const changed = modified(places.file);
		if (changed !== mtime) {
			const read = readTop(places.file);
			if (read !== undefined) {
				top = read;
				mtime = changed;
			}
		}
		if (top === null || lapsed(top, places.now(), zone)) return null;
		leaveRead(places.reads, top.at, places.session());
		return sayTop(top, zone);
	};
}

/** How many sessions have read the top written at `at`. */
export function readsOf(reads: string, at: string): number {
	try {
		return readdirSync(join(reads, keyOf(at))).length;
	} catch {
		// Nobody has read it yet, so there's no folder.
		return 0;
	}
}

/** Tell every session what's on top, as it next works. */
export function registerOnTop(pi: ExtensionAPI): void {
	let session = "";
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		session = ctx.sessionManager.getSessionId();
	});
	registerStandingContext(
		pi,
		ON_TOP,
		onTopReader({
			file: onTopFile(),
			reads: onTopReads(),
			session: () => session,
			now: Date.now,
		}),
	);
}

function missionFolder(
	env: Readonly<Record<string, string | undefined>>,
	home: string,
): string {
	// An empty XDG_STATE_HOME means the default, as the spec says.
	return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "mission");
}

/** The top in the file: null when there's none, undefined when it doesn't parse. */
function readTop(file: string): OnTop | null | undefined {
	if (!existsSync(file)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// Half written, or gone between the look and the read: keep the last.
		return undefined;
	}
	return isRecord(parsed) ? topOf(parsed) : undefined;
}

function topOf(value: Record<string, unknown>): OnTop | undefined {
	const { why, at, until } = value;
	const listed: unknown[] = Array.isArray(value.quests) ? value.quests : [];
	const quests = listed.filter(isRecord).flatMap(questOf);
	if (quests.length === 0) return undefined;
	if (typeof why !== "string" || typeof at !== "string") return undefined;
	return {
		quests,
		why,
		until: typeof until === "string" ? until : null,
		at,
		by: typeof value.by === "string" ? value.by : "joel",
	};
}

/** One quest the file names, or none when it has no id. */
function questOf(
	quest: Record<string, unknown>,
): { id: string; title?: string }[] {
	if (typeof quest.id !== "string") return [];
	if (typeof quest.title !== "string") return [{ id: quest.id }];
	return [{ id: quest.id, title: quest.title }];
}

function lapsed(top: OnTop, now: number, zone: string): boolean {
	return top.until !== null && localDay(now, zone) > top.until;
}

/** The standing text for a top: who, when, until when, which quests and why. */
function sayTop(top: OnTop, zone: string): string {
	const who = top.by === "joel" ? "Joel" : top.by;
	const at = Date.parse(top.at);
	const when = Number.isFinite(at)
		? ` at ${localTime(at, zone)} on ${calendarDay(localDay(at, zone))}`
		: "";
	const until =
		top.until === null
			? "until he takes it down"
			: `until ${calendarDay(top.until)}`;
	const quests = top.quests
		.map((quest) =>
			quest.title === undefined ? quest.id : `${quest.title} (${quest.id})`,
		)
		.join(", ");
	return `${who} put these on top${when}, ${until}: ${quests}. Why, in his words: "${top.why}". Work on them, or that they wait on, comes first; other work yields where it competes with them for Joel, the builders or the machine. Nothing to answer.`;
}

/** Leave this session's read of the top written at `at`, once. */
function leaveRead(reads: string, at: string, session: string): void {
	if (!session) return;
	const folder = join(reads, keyOf(at));
	const mark = join(folder, session);
	if (existsSync(mark)) return;
	try {
		mkdirSync(folder, { recursive: true });
		writeFileSync(mark, "");
	} catch {
		// The receipt is a count, not a gate: a read it misses shows as
		// one fewer, and the session was still told.
	}
}

/** A folder name for a top, from when it was written. */
function keyOf(at: string): string {
	return at.replace(/[^0-9A-Za-z]/g, "-");
}

function modified(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		// No file: nothing is on top.
		return undefined;
	}
}

function localDay(ms: number, zone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(ms));
}

function localTime(ms: number, zone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(new Date(ms));
}

/** `2026-11-20` as `Fri 20 Nov`. */
function calendarDay(day: string): string {
	const date = new Date(`${day}T12:00:00Z`);
	if (!Number.isFinite(date.getTime())) return day;
	const part = (options: Intl.DateTimeFormatOptions) =>
		new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(
			date,
		);
	return `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })}`;
}
