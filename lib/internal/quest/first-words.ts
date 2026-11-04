/**
 * What a session `quest spawn` starts is told first, so it sets to work
 * on its quest by itself rather than sitting idle until somebody pokes
 * it. On 11-03, 7 of 9 builder sessions spawned at 06:56 sat listening
 * until someone pivoted them (P9R1KI [76e6439f]), since a spawn loaded
 * their quest but gave pi no first prompt; Reopen Them All gives each
 * session it reopens its carry-on words, a spawn gave none.
 *
 * The spawn leaves the words in a file named by a key, and the session
 * takes them as it starts. The key is the session's own id when the
 * desktop's launcher opens it, since the launcher carries nothing else
 * through, and otherwise a token the spawn puts in the new pi's
 * environment. A file is taken once, by renaming it away first, and one
 * left too long is dropped, so a session reopened days later is never
 * told what a spawn meant for it then.
 *
 * The session that takes them leaves a record of it beside them, its id
 * and whether it said them, so the spawn can look a minute later for
 * the turn they started in that session's log, and say so when there
 * is none (QEST-20261104-ECNIS5).
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { automatedText } from "../automated.ts";
import { sessionsDir, stateDir } from "../paths.ts";
import { indexSessionFiles } from "./session-liveness.ts";

/** The variable naming a spawned pi's first words, when it has a token. */
export const FIRST_WORDS_VARIABLE = "QUEST_WORKFLOW_FIRST_WORDS";

/**
 * How long words wait for their session. The launcher opens what it is
 * handed one at a time, and after a boot reopened 37 sessions in a few
 * minutes (11-02), so this leaves room for a long queue.
 */
export const FIRST_WORDS_FOR_MS = 15 * 60_000;

/** Keys are session ids or tokens; anything else could leave the folder. */
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

/** Where spawns leave the first words of the sessions they start. */
export function firstWordsDir(): string {
	return join(stateDir("quest-workflow"), "first-words");
}

/**
 * The words a spawned session is told first: carry on with its quest,
 * and, when the spawn gave one, what it was started for.
 */
export function spawnedWords(questId: string, spec?: string): string {
	const body = `Carry on with ${questId}: read its README and its focused plan, then take the plan's next open item and work it through as the plan says.`;
	const told = spec?.trim();
	return automatedText(
		`quest spawn started this session on ${questId}`,
		told ? `${body}\n\nWhat it was started for:\n\n${told}` : body,
	);
}

/** Leave `words` for the session that will start under `key`. */
export function leaveFirstWords(
	key: string,
	words: string,
	dir: string = firstWordsDir(),
	now: number = Date.now(),
): void {
	if (!SAFE_KEY.test(key)) throw new Error(`not a session key: ${key}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${key}.json`);
	// Written whole before it is seen, so a session starting meanwhile
	// never reads half of it.
	const writing = `${path}.writing`;
	writeFileSync(
		writing,
		JSON.stringify({ v: 1, words, at: new Date(now).toISOString() }),
	);
	renameSync(writing, path);
	dropUnlookedTakings(dir, now);
}

/**
 * Remove records of takings no spawn looked for in time, as when the
 * spawner ended within the minute, so they never pile up.
 */
function dropUnlookedTakings(dir: string, now: number): void {
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".taken")) continue;
		const path = join(dir, name);
		try {
			if (now - statSync(path).mtimeMs > FIRST_WORDS_FOR_MS) rmSync(path);
		} catch {
			// Its spawn looked and took it meanwhile.
		}
	}
}

/** Who took a spawn's words, and whether it said them as its first turn. */
export interface Taken {
	readonly sessionId?: string;
	/** False when the session gave way to its command line's own prompt. */
	readonly said: boolean;
}

/**
 * Take the words left under any of `keys`, each file once, answering
 * the first still fresh. Every file found is removed, fresh or not.
 * Given `taken`, it leaves the record of who took the fresh ones under
 * their key, for the spawn that left them.
 */
export function takeFirstWords(
	keys: readonly (string | undefined)[],
	dir: string = firstWordsDir(),
	now: number = Date.now(),
	taken?: Taken,
): string | undefined {
	let found: string | undefined;
	for (const key of keys) {
		if (!key || !SAFE_KEY.test(key)) continue;
		const path = join(dir, `${key}.json`);
		const taking = `${path}.${process.pid}.taking`;
		try {
			renameSync(path, taking);
		} catch {
			// None left under this key, or another process took it first.
			continue;
		}
		const words = wordsIn(taking, now);
		rmSync(taking, { force: true });
		if (words !== undefined && found === undefined && taken) {
			recordTaken(join(dir, `${key}.taken`), taken, now);
		}
		found ??= words;
	}
	return found;
}

/** Leave the record of a taking, never failing the session that took them. */
function recordTaken(path: string, taken: Taken, now: number): void {
	try {
		writeFileSync(
			path,
			JSON.stringify({ v: 1, ...taken, at: new Date(now).toISOString() }),
		);
	} catch {
		// The session still says its words; its spawn only can't tell it did.
	}
}

/**
 * What a spawn's look at its session found: whether the session took a
 * first turn, which session it is when that is known, and otherwise
 * what the records show, as a clause the spawner is told.
 */
export type FirstTurn =
	| { readonly started: true; readonly sessionId: string }
	| {
			readonly started: false;
			readonly sessionId?: string;
			readonly found: string;
	  };

/** Where a look at a spawned session's first turn reads. */
export interface FirstTurnPlaces {
	readonly dir?: string;
	/** pi's session logs. */
	readonly sessions?: string;
	/** The session's id when the spawn knows it, as the launcher's are. */
	readonly sessionId?: string;
	/**
	 * When the spawn was, in epoch ms: only a turn since counts, so a
	 * resumed session's old turns never pass for its first. Without it,
	 * the taking's own time bounds the look.
	 */
	readonly since?: number;
}

/**
 * Whether the session started under `key` took its first turn: its
 * words were taken, and its log holds a turn. Asked once a spawn: the
 * record of the taking goes with the answer.
 */
export function firstTurnOf(
	key: string,
	places: FirstTurnPlaces = {},
): FirstTurn {
	const dir = places.dir ?? firstWordsDir();
	if (!SAFE_KEY.test(key)) {
		return {
			started: false,
			found: `${key} is not a key words are left under`,
		};
	}
	if (existsSync(join(dir, `${key}.json`))) {
		return notStarted(
			places.sessionId,
			"no session has taken the first words the spawn left it, so none started on them",
		);
	}
	const receipt = join(dir, `${key}.taken`);
	const taken = takenIn(receipt);
	rmSync(receipt, { force: true });
	const sessionId = taken?.sessionId ?? places.sessionId;
	if (!sessionId) {
		return notStarted(
			undefined,
			taken
				? "a session took its first words but gave no id to find its log by"
				: "its first words are neither waiting nor recorded as taken",
		);
	}
	const log = indexSessionFiles(places.sessions ?? sessionsDir()).get(
		sessionId,
	);
	const since = places.since ?? (taken ? Date.parse(taken.at) : undefined);
	if (log && holdsTurn(log, since)) return { started: true, sessionId };
	const where = log ? "its log holds no turn" : "there is no session log";
	if (!taken) {
		return notStarted(
			sessionId,
			`its first words are gone with no record of a taking, and ${where}`,
		);
	}
	return notStarted(
		sessionId,
		taken.said
			? `it took its first words at ${taken.at} and said them, but ${where}`
			: `it took its first words at ${taken.at} but put them off for its command line's own prompt, and ${where}`,
	);
}

function notStarted(sessionId: string | undefined, found: string): FirstTurn {
	return { started: false, ...(sessionId ? { sessionId } : {}), found };
}

/** The record of a taking, when there is a whole one. */
function takenIn(path: string): (Taken & { at: string }) | undefined {
	let read: unknown;
	try {
		read = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// No record, or half of one: the look reads as if none was left.
		return undefined;
	}
	if (typeof read !== "object" || read === null) return undefined;
	const { sessionId, said, at } = read as Record<string, unknown>;
	if (typeof said !== "boolean" || typeof at !== "string") return undefined;
	return {
		...(typeof sessionId === "string" ? { sessionId } : {}),
		said,
		at,
	};
}

/**
 * Whether a session log holds a user message, the start of a turn,
 * dated `since` or later when that is given.
 */
function holdsTurn(log: string, since?: number): boolean {
	let text: string;
	try {
		text = readFileSync(log, "utf8");
	} catch {
		// A log that can't be read shows no turn.
		return false;
	}
	return text.split("\n").some((line) => {
		if (!line.includes('"user"')) return false;
		try {
			const entry = JSON.parse(line) as {
				type?: unknown;
				timestamp?: unknown;
				message?: { role?: unknown };
			};
			if (entry.type !== "message" || entry.message?.role !== "user") {
				return false;
			}
			if (since === undefined || !Number.isFinite(since)) return true;
			const at =
				typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
			return at >= since;
		} catch {
			// A torn last line, still being written: not a turn yet.
			return false;
		}
	});
}

/** The words a taken file holds, when it is whole and still fresh. */
function wordsIn(path: string, now: number): string | undefined {
	let read: unknown;
	try {
		read = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// A file that can't be read or parsed tells the session nothing.
		return undefined;
	}
	if (!isLeft(read)) return undefined;
	const at = Date.parse(read.at);
	if (!Number.isFinite(at) || now - at > FIRST_WORDS_FOR_MS) return undefined;
	return read.words;
}

/** Whether a parsed file is words left by a spawn. */
function isLeft(read: unknown): read is { v: 1; words: string; at: string } {
	if (typeof read !== "object" || read === null) return false;
	const { v, words, at } = read as Record<string, unknown>;
	return (
		v === 1 &&
		typeof words === "string" &&
		words !== "" &&
		typeof at === "string"
	);
}
