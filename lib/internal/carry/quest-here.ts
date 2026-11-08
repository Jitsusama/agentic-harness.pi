/**
 * What a quest has on this machine for `pi-carry` to carry: the sessions
 * nobody closed that no pi runs or holds parked, every session it has
 * had, the trees the work broker cut and who holds each, and the trees
 * its README lists here.
 *
 * A session a pi runs, or holds parked, carries its own work when it is
 * steered to, so only the rest are named here. One closed on purpose is
 * not carried, since nobody would take it up there; the trees it held
 * still are, as the quest's.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QuestFrontMatter } from "../../quest/types.ts";
import { localProcessDeps, probeProcess } from "../quest/process-liveness.ts";
import { parseQuestDoc } from "../quest/quest-doc.ts";
import { indexSessionFiles } from "../quest/session-liveness.ts";
import {
	parseSessionRecord,
	type SessionRecord,
	wasLost,
} from "../quest/session-registry.ts";
import { treesHere } from "../quest/tree-place.ts";
import { type RecordedTree, recordedTrees } from "../work-records.ts";

/** A session of the quest that no pi runs, to be carried by `pi-carry`. */
export interface RestingSession {
	readonly id: string;
	readonly cwd: string;
	readonly title?: string;
	readonly file?: string;
}

/** What a quest has on this machine. */
export interface QuestHere {
	readonly quest: string;
	/** Its sessions nobody closed that no pi runs or holds parked. */
	readonly resting: readonly RestingSession[];
	/** Every session it has had here, whose trees are its own. */
	readonly sessions: ReadonlySet<string>;
	/** Each tree the work broker cut, with the sessions holding it. */
	readonly held: readonly RecordedTree[];
	/** The trees its README lists on this machine. */
	readonly trees: readonly string[];
}

/** Where the stores are read from. */
export interface Stores {
	/** The quest workflow's session records (loaded.ts's sessionRegistryDir). */
	readonly registry: string;
	/** The quest store, a folder per quest. */
	readonly quests: string;
	/** The work broker's records (work-records.ts). */
	readonly treeRecords: string;
	/** pi's session store. */
	readonly sessionStore: string;
}

/** How a session's pi is asked after; real processes unless a test says. */
export interface Liveness {
	/** Whether the pi its record names runs now. */
	readonly runs: (record: SessionRecord) => boolean;
	/** Whether it is parked for its holder to start again. */
	readonly parked: (session: string) => boolean;
}

/** What `quest` has on this machine, read from `stores`. */
export function questHere(
	quest: string,
	stores: Stores,
	liveness: Liveness,
): QuestHere {
	const records = readRecords(stores.registry);
	const readme = readReadme(stores.quests, quest);
	const files = indexSessionFiles(stores.sessionStore);
	const titles = new Map(
		(readme?.sessions ?? []).flatMap((one) =>
			one.name ? [[one.id, one.name]] : [],
		),
	);
	const resting = records
		.filter((record) => record.quest === quest)
		.filter((record) => !record.closedAt || wasLost(record))
		.filter(
			(record) => !liveness.runs(record) && !liveness.parked(record.sessionId),
		)
		.map((record): RestingSession => {
			const title = titles.get(record.sessionId);
			const file = files.get(record.sessionId);
			return {
				id: record.sessionId,
				cwd: record.cwd,
				...(title ? { title } : {}),
				...(file ? { file } : {}),
			};
		});
	const sessions = new Set([
		...records
			.filter(
				(record) => record.quest === quest || record.previousQuests?.[quest],
			)
			.map((record) => record.sessionId),
		...(readme?.sessions ?? []).map((one) => one.id),
	]);
	return {
		quest,
		resting,
		sessions,
		held: recordedTrees(stores.treeRecords),
		trees: treesHere(readme?.trees ?? []).map((tree) => tree.path),
	};
}

/** Whether a record's pi runs now, asked of this machine's processes. */
export function runsHere(record: SessionRecord): boolean {
	return (
		record.process !== undefined &&
		probeProcess(record.process, localProcessDeps()) === "matching"
	);
}

function readRecords(dir: string): SessionRecord[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// No registry: no session has loaded a quest on this machine.
		return [];
	}
	return names
		.filter((name) => name.endsWith(".json"))
		.sort()
		.flatMap((name) => {
			try {
				return (
					parseSessionRecord(
						JSON.parse(readFileSync(join(dir, name), "utf8")),
					) ?? []
				);
			} catch {
				// Half written or gone since the listing: no session to trust.
				return [];
			}
		});
}

function readReadme(
	quests: string,
	quest: string,
): QuestFrontMatter | undefined {
	try {
		return parseQuestDoc(readFileSync(join(quests, quest, "README.md"), "utf8"))
			?.frontMatter;
	} catch {
		// No such quest here: it lists no trees or sessions on this machine.
		return undefined;
	}
}
