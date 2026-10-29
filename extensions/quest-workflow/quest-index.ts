/**
 * The open quests, kept on disk for the desktop.
 *
 * The launcher's Agents place lists quests with their documents and
 * sessions, and starts a session for one. It reads them from
 * `quests.json` in quest-workflow's state folder rather than parsing
 * every README in QML. Like `orchestrators.json`, the file is looked at
 * again after every quest action and at each session start, and
 * written only when it changed. What a session is doing now stays in
 * presence, and what waits on the person in the waiting files.
 *
 * `start` is where a new session for the quest opens, chosen as
 * `quest spawn` chooses it (newest tree, then a recent session's
 * folder, then a tree's repo, then home, never the quest store). The
 * file is rebuilt after every quest action, so a session is judged more
 * cheaply than spawn judges it: a process gone from `/proc`, or from an
 * earlier boot, is dead, and any other is not, without running `ps` to
 * compare its start (about 10 ms a session) or asking a terminal for
 * its pane. A pid taken again by another process, which spawn alone
 * catches, can leave a dead session's folder in `start`, behind every
 * tree the quest has.
 */

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { sessionsDir, stateDir } from "../../lib/internal/paths.ts";
import {
	discoverQuests,
	type QuestIndex,
} from "../../lib/internal/quest/discovery.ts";
import { orchestrationOf } from "../../lib/internal/quest/orchestration.ts";
import {
	currentBootToken,
	type ProcessInspection,
	probeProcess,
} from "../../lib/internal/quest/process-liveness.ts";
import { extractSectionParagraph } from "../../lib/internal/quest/quest-doc.ts";
import {
	resolveSpawnCwd,
	sessionToReopen,
} from "../../lib/internal/quest/reopen.ts";
import {
	activityFromIndex,
	buildLivenessSnapshot,
	deriveLiveness,
	indexSessionFiles,
	type LivenessSnapshot,
} from "../../lib/internal/quest/session-liveness.ts";
import { questAddress } from "../../lib/mesh/address.ts";
import type { QuestSession } from "../../lib/quest/index.ts";
import type { TerminalProbe } from "../../lib/terminal/index.ts";
import { writeWhenChanged } from "./desktop-file.ts";
import {
	byRank,
	isOpen,
	orchestratorsIn,
	writeOrchestrators,
} from "./orchestrators.ts";

/** One document of a quest, as the desktop lists it. */
export interface QuestIndexDocument {
	readonly id: string;
	readonly kind: string;
	readonly title: string;
	readonly stage: string;
}

/** One open quest, as the desktop lists it. */
export interface QuestIndexEntry {
	readonly id: string;
	/** The mesh address its session signs with. */
	readonly address: string;
	readonly short?: string;
	readonly title: string;
	/** The Summary's first paragraph, as plain text. */
	readonly summary?: string;
	readonly kind: string;
	readonly status: string;
	readonly priority: string;
	readonly rank: number;
	readonly parent?: string;
	/** The address of the orchestrator it answers to, when one is above it. */
	readonly orchestrator?: string;
	readonly documents: readonly QuestIndexDocument[];
	/**
	 * Its sessions still running, by id: attached and not found dead, so a
	 * README entry left reading active after its process went is not one.
	 */
	readonly sessions: readonly string[];
	/**
	 * The session a closed quest is reopened in, and the folder it ran in:
	 * its newest saved session, absent when that one's folder is gone.
	 */
	readonly resume?: { readonly id: string; readonly cwd: string };
	/** The folder a new session for it opens in. */
	readonly start: string;
	readonly updated: string;
}

/** Where the index is kept. */
export function questIndexPath(): string {
	return join(stateDir("quest-workflow"), "quests.json");
}

let running: Promise<void> | undefined;
let again = false;

/**
 * Bring both of the desktop's lists up to date with the quests as they
 * stand, from one walk of the store: this index and `orchestrators.json`.
 * Calls made while one is under way fold into one more pass after it. A
 * list that can't be built or written leaves the last one standing: no
 * quest action waits on it or fails for it.
 */
export function keepDesktopListsCurrent(questsRoot: string): Promise<void> {
	if (running) {
		again = true;
		return running;
	}
	running = (async () => {
		// About 130 ms on 729 quests, so the quest action that asked
		// answers first.
		await new Promise((next) => setImmediate(next));
		do {
			again = false;
			try {
				const { index } = discoverQuests(questsRoot);
				try {
					writeOrchestrators(orchestratorsIn(index));
				} catch {
					// The quest index is still worth writing; the next pass retries.
				}
				const snapshot = await snapshotOf(openSessions(index));
				writeWhenChanged(questIndexPath(), {
					quests: questsIn(index, snapshot, questsRoot),
				});
			} catch {
				// The next quest action tries again.
			}
		} while (again);
	})().finally(() => {
		running = undefined;
	});
	return running;
}

/**
 * Every open quest in tree order, parents before children and siblings
 * by rank, given what is known of their sessions.
 */
export function questsIn(
	index: QuestIndex,
	snapshot: LivenessSnapshot,
	store: string,
	home?: string,
): QuestIndexEntry[] {
	const found: QuestIndexEntry[] = [];
	const seen = new Set<string>();
	const read = (id: string) => index.quests.get(id)?.doc.frontMatter;
	const visit = (parent: string) => {
		const ids = [...(index.children.get(parent) ?? [])].sort(byRank(index));
		for (const id of ids) {
			if (seen.has(id)) continue;
			seen.add(id);
			const entry = index.quests.get(id);
			if (!entry) continue;
			const fm = entry.doc.frontMatter;
			if (isOpen(fm.status)) {
				const by = orchestrationOf(id, read).by;
				const summary = extractSectionParagraph(entry.doc.body, "summary");
				const sessions = fm.sessions.map((s) => deriveLiveness(s, snapshot));
				const start = resolveSpawnCwd({
					questDir: entry.dir,
					store,
					...(home ? { home } : {}),
					trees: fm.trees ?? [],
					sessions,
				}).cwd;
				const resume = sessionToReopen({
					questDir: entry.dir,
					store,
					sessions,
				});
				found.push({
					id,
					address: questAddress(id),
					...(fm.short ? { short: fm.short } : {}),
					title: entry.doc.title ?? id,
					...(summary ? { summary } : {}),
					kind: fm.kind,
					status: fm.status,
					priority: fm.priority,
					rank: fm.rank,
					...(fm.parent ? { parent: fm.parent } : {}),
					...(by ? { orchestrator: questAddress(by) } : {}),
					documents: entry.documents.map(({ doc }) => ({
						id: doc.frontMatter.id,
						kind: doc.frontMatter.kind,
						title: doc.title ?? doc.frontMatter.id,
						stage: doc.frontMatter.stage,
					})),
					sessions: sessions
						.filter((s) => s.liveness !== "detached" && s.liveness !== "dead")
						.map((s) => s.id),
					...(resume ? { resume } : {}),
					start,
					updated: fm.updated,
				});
			}
			visit(id);
		}
	};
	visit("");
	return found;
}

function openSessions(index: QuestIndex): QuestSession[] {
	return [...index.quests.values()]
		.filter((entry) => isOpen(entry.doc.frontMatter.status))
		.flatMap((entry) => entry.doc.frontMatter.sessions);
}

/** Sessions' activity and whether their processes are gone. */
function snapshotOf(
	sessions: readonly QuestSession[],
): Promise<LivenessSnapshot> {
	const logs = indexSessionFiles(sessionsDir());
	const boot = currentBootToken();
	const processes = {
		localHostId: hostname(),
		inspect: stillThere,
		...(boot ? { localBootToken: boot } : {}),
	};
	return buildLivenessSnapshot(sessions, {
		activityOf: (id) => activityFromIndex(logs, id),
		probeProcess: (id) => probeProcess(id, processes),
		probeTerminals: async () => new Map<string, TerminalProbe>(),
	});
}

/**
 * Whether a pid is held at all, from `/proc`. Unknown rather than gone
 * where there is no `/proc`, so nothing is called dead it can't see.
 */
function stillThere(pid: number): ProcessInspection {
	if (!existsSync("/proc/self")) return { kind: "unknown" };
	return existsSync(`/proc/${pid}`) ? { kind: "unknown" } : { kind: "gone" };
}
