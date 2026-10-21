/**
 * What a session is called in the mail.
 *
 * People already call a session by its quest, the last six letters of
 * the quest id (P9R1KI), so that is its name. A session can have been on
 * several quests, so the one it has loaded comes first and is what it
 * signs with; any other quest whose README lists it is an alias, so mail
 * sent under an older name still arrives. The last eight characters of
 * its session id always name it too, which is all a session on no quest
 * has: the last rather than the first, because a pi session id begins
 * with its start time, and sessions started in the same minute shared a
 * first eight.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the quest workflow keeps what naming reads. */
export interface NamingPaths {
	/** One record per pi session, naming the quest it has loaded. */
	readonly sessions: string;
	/** One folder per quest, each with a README. */
	readonly quests: string;
}

/** The name a quest gives a session: its id's last six letters. */
export function questName(questId: string): string {
	return (questId.split("-").pop() ?? questId).toUpperCase();
}

/** Every name this session answers to, the one it signs with first. */
export function namesFor(sessionId: string, paths: NamingPaths): string[] {
	const own = sessionId.replace(/-/g, "").slice(-8).toUpperCase();
	const loaded = loadedQuest(sessionId, paths.sessions);
	const listed: string[] = [];
	let quests: string[] = [];
	try {
		quests = readdirSync(paths.quests);
	} catch {
		// No quest store: the session id alone names it.
	}
	for (const quest of quests) {
		let readme: string;
		try {
			readme = readFileSync(join(paths.quests, quest, "README.md"), "utf8");
		} catch {
			continue;
		}
		const name = questName(quest);
		if (readme.includes(sessionId) && name !== loaded) listed.push(name);
	}
	return [...(loaded ? [loaded] : []), ...listed, own];
}

/** The quest this session has loaded, by name, when its record says. */
function loadedQuest(sessionId: string, sessions: string): string | undefined {
	try {
		const record: unknown = JSON.parse(
			readFileSync(join(sessions, `${sessionId}.json`), "utf8"),
		);
		const quest = (record as { quest?: unknown } | null)?.quest;
		return typeof quest === "string" ? questName(quest) : undefined;
	} catch {
		return undefined;
	}
}
