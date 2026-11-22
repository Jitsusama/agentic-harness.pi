/**
 * A session the mycelium holds that starts with no quest makes one from
 * the first thing its person types, so the work it goes on to do is
 * found under a quest rather than nowhere. The quest takes its title
 * from their first line and its summary from their words, and is marked
 * as this session's.
 *
 * Only where a person is typing into a held session: a subagent, a pi
 * off the mesh, a sprout (which makes its own) and a session that
 * restored or loaded a quest make none, and neither does a command or a
 * prompt after the first.
 *
 * A quest made this way and then left as it was made is cleared when
 * its session ends for good: retired, which can be undone, rather than
 * kept as an empty quest nobody chose. Left as made means its summary
 * and journey read as they did, its folder holds nothing else, its
 * workspace holds no file, it has no trees and no other session ever
 * joined it. A session parked, restarted to roll over, or taken away by
 * a signal or its host comes back to its quest, so none of those clears
 * it; only a quit its person made does.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isQuestMachinery } from "../../../lib/core/internal/quest/record-audit.ts";
import type { QuestResult } from "../../../lib/core/quest/verbs/shared.ts";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/documents/frontmatter.ts";
import { mutateQuestFrontMatter } from "../../../lib/internal/quest/fields/mutate.ts";
import { titleFromWords } from "../../../lib/internal/quest/sessions/sprout-seed.ts";
import { isSealedStatus } from "../../../lib/internal/quest/status.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import { isSubagent } from "../../../lib/mesh/hand.ts";
import type { QuestState } from "../state.ts";
import type { create } from "../verbs/lifecycle.ts";
import type { sealLoadedQuest } from "../verbs/seal.ts";
import { defaultWorkspaceRoot, workspaceDirOf } from "../workspace.ts";

/** The `_extra` key a quest made from a first prompt is marked under. */
export const FORAGE_KEY = "forage";

/** The most characters of the person's words kept as the summary. */
const NOTE_MOST = 2_000;

/** The files a quest made from a first prompt holds while left as made. */
const MADE_FILES = new Set(["README.md", "JOURNEY.md"]);

/** Why a quest left as made is retired, as its journey says. */
export const LEFT_NOTHING = "its session ended having left nothing in it";

/** What a person typed, as pi's `input` event carries it. */
export interface FirstPrompt {
	readonly text: string;
	readonly source: string;
}

/** What decides whether a session's prompt makes it a quest. */
export interface ForageGround {
	readonly env: NodeJS.ProcessEnv;
	readonly hasUI: boolean;
	/** A quest is loaded, restored or made by a sprout's start. */
	readonly questLoaded: boolean;
	/** The start read a sprout's seed, whose own start makes its quest. */
	readonly sprouted: boolean;
	/** The session's log already holds something its person typed. */
	readonly typedBefore: boolean;
	/** This session already tried, whatever came of it. */
	readonly tried: boolean;
}

/** Whether `prompt` is the first a held session's person typed, to make a quest of. */
export function makesQuest(prompt: FirstPrompt, ground: ForageGround): boolean {
	if (prompt.source !== "interactive") return false;
	if (ground.tried || ground.questLoaded || ground.sprouted) return false;
	if (ground.typedBefore) return false;
	if (!ground.env.MYCELIUM_HELD || !ground.hasUI) return false;
	if (isSubagent(ground.env) || ground.env.PI_MESH === "off") return false;
	const text = prompt.text.trim();
	return text !== "" && !text.startsWith("/");
}

/** Whether a session log's entries hold a message its person sent. */
export function typedBefore(entries: readonly unknown[]): boolean {
	return entries.some(
		(entry) =>
			isRecord(entry) &&
			entry.type === "message" &&
			isRecord(entry.message) &&
			entry.message.role === "user",
	);
}

/** Makes a quest as `quest create` does, for a test to stand in for. */
export type Make = (
	params: Parameters<typeof create>[3],
) => Promise<QuestResult>;

/**
 * Make a quest from `text`, the first thing session `session`'s person
 * typed, and mark it as that session's. Says the quest's id, or nothing
 * when none was made.
 */
export async function forageQuest(
	state: QuestState,
	session: string,
	text: string,
	make: Make,
): Promise<string | undefined> {
	const words = text.trim();
	const made = await make({
		action: "create",
		kind: "quest",
		priority: "active",
		title: titleFromWords(words),
		note: words.length > NOTE_MOST ? `${words.slice(0, NOTE_MOST)}...` : words,
	});
	const id = made.ok ? made.details?.id : undefined;
	if (typeof id !== "string") return undefined;
	const dir = state.questId === id ? state.questDir : undefined;
	if (!dir) return id;
	try {
		mutateQuestFrontMatter(dir, (fm) => ({
			...fm,
			_extra: { ...fm._extra, [FORAGE_KEY]: { session, ...asMade(dir) } },
		}));
	} catch {
		// Unmarked, the quest is only never cleared: it stands as any quest
		// a person made, which is the safe side of a lock that didn't come.
	}
	return id;
}

/** How a session's end bears on clearing the quest its first prompt made. */
export interface SessionEnd {
	/** pi's reason for shutting the session down. */
	readonly reason: string;
	/** It said it parks, so its holder wakes it on its quest. */
	readonly parking: boolean;
	/** A rollover's restart its holder took, coming back on its quest. */
	readonly restarting: boolean;
	/** A signal took it away, which pi reports as a quit. */
	readonly signalled: boolean;
}

/** Whether a session's end is a quit its person made, the one end that clears. */
export function endsForGood(end: SessionEnd): boolean {
	return (
		end.reason === "quit" && !end.parking && !end.restarting && !end.signalled
	);
}

/** Retires the loaded quest as `quest retire` does, for a test to stand in for. */
export type Retire = (
	params: Parameters<typeof sealLoadedQuest>[2],
) => Promise<QuestResult>;

/**
 * Retire the loaded quest when session `session`'s first prompt made it
 * and it is left as made, saying whether it was.
 */
export async function clearIfLeftAsMade(
	state: QuestState,
	session: string,
	retire: Retire,
): Promise<boolean> {
	if (!leftAsMade(state, session)) return false;
	const sealed = await retire({ action: "retire", reason: LEFT_NOTHING });
	return sealed.ok;
}

/** Whether the loaded quest is one `session` made from a prompt and left as made. */
export function leftAsMade(state: QuestState, session: string): boolean {
	return whyKept(state, session) === undefined;
}

/**
 * Why the loaded quest stays when `session` ends, or nothing when
 * `session`'s first prompt made it and it is left as made.
 */
export function whyKept(
	state: QuestState,
	session: string,
): string | undefined {
	const { questDir: dir, questId: id } = state;
	if (!dir || !id) return "no quest is loaded";
	let text: string;
	try {
		text = readFileSync(join(dir, "README.md"), "utf8");
	} catch {
		// A README that can't be read can't show it was left as made, so
		// the quest stays.
		return "its README couldn't be read";
	}
	const fm = parseQuestFrontMatter(text)?.frontMatter;
	if (!fm) return "its README has no front matter";
	if (isSealedStatus(fm.status)) return `it is already ${fm.status}`;
	const mark = fm._extra?.[FORAGE_KEY];
	if (!isRecord(mark) || mark.session !== session)
		return "this session's first prompt didn't make it";
	const now = asMade(dir);
	if (mark.readme !== now.readme) return "its README was changed";
	if (mark.journey !== now.journey) return "its journey was written to";
	const other = fm.sessions.find((one) => one.id !== session);
	if (other) return `session ${other.id} was on it`;
	if ((fm.trees ?? []).length > 0) return "it holds a tree";
	const extra = readdirSync(dir).find(
		(name) => !MADE_FILES.has(name) && !isQuestMachinery(name),
	);
	if (extra) return `its folder holds ${extra}`;
	const workspace = workspaceDirOf(defaultWorkspaceRoot(), id);
	if (workspace !== undefined && holdsAFile(workspace))
		return "its workspace holds a file";
	return undefined;
}

/** Digests of a quest's body and journey, to tell later whether either changed. */
function asMade(dir: string): { readme: string; journey: string } {
	const readme = readFileSync(join(dir, "README.md"), "utf8");
	return {
		readme: digest(parseQuestFrontMatter(readme)?.body ?? readme),
		journey: digest(readOr(join(dir, "JOURNEY.md"))),
	};
}

/** A file's text, or nothing when it isn't there. */
function readOr(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		// No journey yet reads as an empty one, written or not.
		return "";
	}
}

/** A text's sha256, in hex. */
function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Whether a folder, or any folder under it, holds anything but folders. */
function holdsAFile(dir: string): boolean {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		// No workspace holds nothing; one that can't be read might hold
		// work, so it counts as holding some.
		return !(isRecord(error) && error.code === "ENOENT");
	}
	return names.some((name) => {
		const path = join(dir, name);
		try {
			return statSync(path).isDirectory() ? holdsAFile(path) : true;
		} catch {
			// Gone between the listing and here, or unreadable: counted as
			// holding something, so the quest stays.
			return true;
		}
	});
}
