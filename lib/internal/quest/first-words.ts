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
 */

import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { automatedText } from "../automated.ts";
import { stateDir } from "../paths.ts";

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
}

/**
 * Take the words left under any of `keys`, each file once, answering
 * the first still fresh. Every file found is removed, fresh or not.
 */
export function takeFirstWords(
	keys: readonly (string | undefined)[],
	dir: string = firstWordsDir(),
	now: number = Date.now(),
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
		found ??= words;
	}
	return found;
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
