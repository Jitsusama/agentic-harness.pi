/**
 * What a session the host parked for a roll is told when a pi next
 * starts on it.
 *
 * The host rolls its children onto new code each hour: a conversation
 * parks at its next quiet moment and the next wake starts a fresh
 * child on the new code (host/service/stale-child.ts). Until now the
 * session was told nothing of it. On 27 November A210E4CA read such
 * sessions as cut off: each slept until a message woke it, then began
 * with no word of the roll or of what it had been doing.
 *
 * So the host leaves one custom entry, {@link ROLLED_ENTRY}, as it
 * parks a conversation for a roll, and the next start reads it here
 * and tells the session once: when it parked, onto which code, and
 * the last thing it said before. A start that finds no entry says
 * nothing of a roll.
 */

import type {
	CustomMessageEntry,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { LOADED_MESSAGE } from "./loaded.ts";

/** The custom entry the host appends as it parks a conversation for a roll. */
export const ROLLED_ENTRY = "host:rolled";

/** How many characters of the session's last words the note quotes. */
const LAST_WORDS_CHARS = 280;

/** How many characters of a commit the note names. */
const SHORT_SHA = 8;

/** What the host says of a roll in its entry. */
export interface Rolled {
	/** The host code the conversation ran on before, as a sha. */
	readonly from: string;
	/** The host code it rolled onto, as a sha. */
	readonly onto: string;
	/** When it parked, as an ISO time. */
	readonly at: string;
	/**
	 * Whether the host wakes it on the new code at once, with nobody
	 * sending it anything: the note then starts its turn.
	 */
	readonly wakes: boolean;
}

/** A roll still to be told, and what the session last said before it. */
export interface RollToTell {
	readonly rolled: Rolled;
	readonly lastWords: string | undefined;
}

/** Whether a custom entry's data is a roll as the host writes one. */
function isRolled(data: unknown): data is Omit<Rolled, "wakes"> {
	if (typeof data !== "object" || data === null) return false;
	const from: unknown = Reflect.get(data, "from");
	const onto: unknown = Reflect.get(data, "onto");
	const at: unknown = Reflect.get(data, "at");
	return (
		typeof from === "string" &&
		typeof onto === "string" &&
		typeof at === "string" &&
		!Number.isNaN(Date.parse(at))
	);
}

/** The text of an assistant message, or undefined for any other entry. */
function assistantText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "assistant") {
		return undefined;
	}
	const text = entry.message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return text === "" ? undefined : text;
}

/** Whether an entry is a note on which harness code runs. */
function isLoadedNote(entry: SessionEntry): entry is CustomMessageEntry {
	return entry.type === "custom_message" && entry.customType === LOADED_MESSAGE;
}

/**
 * The roll a session's log owes it word of: the host's last roll entry,
 * when nothing came after it that a pi on the new code said, neither a
 * note on what runs nor a reply. A session that already carried on, or
 * was told, is owed nothing; so is one the host never rolled.
 */
export function rollToTell(
	entries: readonly SessionEntry[],
): RollToTell | undefined {
	let index = entries.length - 1;
	for (; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry === undefined) continue;
		if (isLoadedNote(entry) || assistantText(entry) !== undefined) {
			return undefined;
		}
		if (entry.type === "custom" && entry.customType === ROLLED_ENTRY) break;
	}
	const entry = entries[index];
	if (entry?.type !== "custom" || !isRolled(entry.data)) return undefined;
	const wakes = Reflect.get(entry.data, "wakes") === true;
	let lastWords: string | undefined;
	for (let before = index - 1; before >= 0 && !lastWords; before -= 1) {
		const earlier = entries[before];
		if (earlier !== undefined) lastWords = assistantText(earlier);
	}
	return { rolled: { ...entry.data, wakes }, lastWords };
}

/** A session's last words, cut to a length a note can quote. */
function quoted(words: string): string {
	if (words.length <= LAST_WORDS_CHARS) return words;
	return `${words.slice(0, LAST_WORDS_CHARS).trimEnd()}...`;
}

/**
 * What to tell a rolled session: `now` is what runs, as describeLoaded
 * says it, and `clock` says a time as the person's clock does.
 */
export function rolledText(
	roll: RollToTell,
	now: string,
	clock: (at: number) => string,
): string {
	const { rolled, lastWords } = roll;
	const lines = [
		`The host parked this session at ${clock(Date.parse(rolled.at))} to roll it onto new code (host ${rolled.onto.slice(0, SHORT_SHA)}, from ${rolled.from.slice(0, SHORT_SHA)}), and this pi started on it afresh; nothing went wrong.`,
		now,
	];
	if (lastWords !== undefined) {
		lines.push(`Before the roll you last said: "${quoted(lastWords)}"`);
	}
	lines.push(
		"Any background job the roll ended is said on its own.",
		"Carry on from where you were.",
	);
	return lines.join(" ");
}
