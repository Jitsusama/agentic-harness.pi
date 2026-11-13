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
 *
 * The concluded and retired quests, which the launcher finds as it is
 * typed in, are kept apart in `ended.json`, with less of each: no
 * documents, sessions or session to reopen, which an ended quest has no
 * more of. They are many more than the open ones and change only as a
 * quest ends or reopens, so a quest action rewrites only the short list
 * of open ones, and the realm's node, which serves both, reads the long
 * one again only when it changed.
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
	ancestorTreesOf,
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
import { rosterHolds } from "../../lib/internal/session/host-holds.ts";
import { questAddress } from "../../lib/mesh/address.ts";
import { createPresences } from "../../lib/mesh/presence.ts";
import type { QuestSession } from "../../lib/quest/index.ts";
import type { TerminalProbe } from "../../lib/terminal/index.ts";
import { writeWhenChanged } from "./desktop-file.ts";
import {
	byRank,
	isOpen,
	orchestratorsIn,
	writeOrchestrators,
} from "./orchestrators.ts";
import { loadRecords } from "./session-registry.ts";

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
	/**
	 * The name its team goes by in the swarm, from its `swarm:` alias,
	 * which the realm's node serves with the quest so its person types
	 * the name they call it by rather than one worked out of its title.
	 */
	readonly swarm?: string;
	readonly title: string;
	/** The Summary's first paragraph, as plain text. */
	readonly summary?: string;
	readonly kind: string;
	/**
	 * The kind again, under a name the node leaves alone: it serves every
	 * record with `kind` set to its own, "quest", so a subquest or a
	 * sidequest would reach the launcher as a quest, as runs did.
	 */
	readonly "quest.kind": string;
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
	 * The session a closed quest is reopened in, the folder it ran in, and
	 * when it was last live (ISO): its newest saved session, absent when
	 * that one's folder is gone. Last live is the later of its log's
	 * newest entry and its presence on the mesh, which an idle session
	 * keeps writing while its log stands still. While that session runs
	 * it is said only to the hour (see {@link toTheHour}).
	 */
	readonly resume?: {
		readonly id: string;
		readonly cwd: string;
		readonly at?: string;
	};
	/** The folder a new session for it opens in. */
	readonly start: string;
	readonly updated: string;
}

/** One concluded or retired quest, as the desktop finds it. */
export interface EndedQuestEntry {
	readonly id: string;
	readonly address: string;
	readonly short?: string;
	readonly title: string;
	/** The Summary's first paragraph, as plain text. */
	readonly summary?: string;
	readonly kind: string;
	/** The kind again, which the node leaves alone, as an open quest's. */
	readonly "quest.kind": string;
	readonly status: string;
	readonly parent?: string;
	/** The folder a new session for it opens in. */
	readonly start: string;
	readonly updated: string;
}

/** Where the index is kept. */
export function questIndexPath(): string {
	return join(stateDir("quest-workflow"), "quests.json");
}

/** Where the list of ended quests is kept. */
export function endedQuestsPath(): string {
	return join(stateDir("quest-workflow"), "ended.json");
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
				const presences = createPresences(
					join(stateDir("mesh-workflow"), "presence"),
				);
				writeWhenChanged(questIndexPath(), {
					quests: questsIn(
						index,
						snapshot,
						questsRoot,
						undefined,
						lastQuests(),
						(session) => presences.of(session)?.at,
					),
				});
				writeWhenChanged(endedQuestsPath(), {
					quests: endedQuestsIn(index, questsRoot),
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
	/** The quest each session was last on, by the session registry. */
	lastQuestOf: (sessionId: string) => string | undefined = () => undefined,
	/** When each session last said it was on the mesh, ISO. */
	presentAt: (sessionId: string) => string | undefined = () => undefined,
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
					ancestors: ancestorTreesOf(fm.parent ?? undefined, read),
				}).cwd;
				const reopened = sessionToReopen({
					questDir: entry.dir,
					store,
					sessions,
					// A session the registry never knew is judged by the README.
					stillOn: (session) => (lastQuestOf(session) ?? id) === id,
				});
				const running = sessions
					.filter((s) => s.liveness !== "detached" && s.liveness !== "dead")
					.map((s) => s.id);
				const lastLive =
					reopened &&
					latest(
						sessions.find((s) => s.id === reopened.id)?.lastActivity,
						presentAt(reopened.id),
					);
				const at =
					lastLive && reopened && running.includes(reopened.id)
						? toTheHour(lastLive)
						: lastLive;
				const resume = reopened && { ...reopened, ...(at ? { at } : {}) };
				const swarm = fm.aliases.find((alias) => alias.type === "swarm")?.value;
				found.push({
					id,
					address: questAddress(id),
					...(fm.short ? { short: fm.short } : {}),
					...(swarm ? { swarm } : {}),
					title: entry.doc.title ?? id,
					...(summary ? { summary } : {}),
					kind: fm.kind,
					"quest.kind": fm.kind,
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
					sessions: running,
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

/**
 * Every concluded or retired quest, by id, each with the folder a new
 * session for it opens in, chosen as for an open one. Its sessions have
 * all ended, so the newest to start counts first, as the README says,
 * and none is asked whether it still runs.
 */
export function endedQuestsIn(
	index: QuestIndex,
	store: string,
	home?: string,
): EndedQuestEntry[] {
	const read = (id: string) => index.quests.get(id)?.doc.frontMatter;
	return [...index.quests.entries()]
		.filter(([, entry]) => !isOpen(entry.doc.frontMatter.status))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, entry]) => {
			const fm = entry.doc.frontMatter;
			const summary = extractSectionParagraph(entry.doc.body, "summary");
			const start = resolveSpawnCwd({
				questDir: entry.dir,
				store,
				...(home ? { home } : {}),
				trees: fm.trees ?? [],
				sessions: fm.sessions.map((session) => ({
					...session,
					liveness: "detached" as const,
					...(session.started ? { lastActivity: session.started } : {}),
				})),
				ancestors: ancestorTreesOf(fm.parent ?? undefined, read),
			}).cwd;
			return {
				id,
				address: questAddress(id),
				...(fm.short ? { short: fm.short } : {}),
				title: entry.doc.title ?? id,
				...(summary ? { summary } : {}),
				kind: fm.kind,
				"quest.kind": fm.kind,
				status: fm.status,
				...(fm.parent ? { parent: fm.parent } : {}),
				start,
				updated: fm.updated,
			};
		});
}

/** The later of two ISO times, as ISO; either may be missing or unreadable. */
function latest(...times: readonly (string | undefined)[]): string | undefined {
	const read = times
		.map((time) => (time ? Date.parse(time) : Number.NaN))
		.filter((ms) => !Number.isNaN(ms));
	return read.length > 0
		? new Date(Math.max(...read)).toISOString()
		: undefined;
}

/**
 * An ISO time cut back to its hour. A running session's presence moves
 * every few seconds, and the launcher reads when a quest was last live
 * only to order those closed (core's `Orchestrators.qml`), so said
 * exactly it rewrote the whole list each pass for nothing a reader
 * shows: on 10 November every 7 to 10 s, at 618 ms of the shell's main
 * thread each (PT5P13). From the first pass after the session ends it
 * is said exactly, and stands still.
 */
function toTheHour(iso: string): string {
	const at = new Date(iso);
	at.setUTCMinutes(0, 0, 0);
	return at.toISOString();
}

/** Each recorded session's last quest, read once per pass. */
function lastQuests(): (sessionId: string) => string | undefined {
	const quests = new Map<string, string>();
	for (const { record } of loadRecords()) {
		if (record.quest) quests.set(record.sessionId, record.quest);
	}
	return (sessionId) => quests.get(sessionId);
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
		// A hosted session runs while its host keeps it, whatever pid its
		// README entry names.
		held: rosterHolds(),
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
