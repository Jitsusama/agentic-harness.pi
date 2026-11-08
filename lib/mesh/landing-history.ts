/**
 * Every landing the machine's sessions said, kept a month in one file.
 *
 * A presence keeps a session's newest five landings for a day and goes
 * when the session does, so the desktop's Landed list lost what landed
 * with each session that ended: VKCF3Z graded it severity 4 on 7
 * November, "gone when its session ends; no quest, repo, machine; no
 * history". So each landing is also kept here, with whose it was and
 * where, for 30 days, newest first. The mycelium node serves the file
 * whole, as it does quests.json; nothing here reads it back but the
 * writes.
 *
 * Many sessions land at once, so each write takes the file's lock,
 * reads what is there, adds or takes away one, prunes past the month
 * and replaces the file whole. A landing is kept once by its key, the
 * session and the ref, so one said again stands in for the first.
 */

import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../core/internal/file-lock.ts";
import type { Landing } from "../internal/session/landings.ts";
import { writeWhole } from "../internal/write-whole.ts";

/** The history's file name, in the mesh's state folder. */
export const LANDING_HISTORY_FILE = "landings.json";

/** How long a landing is kept. */
export const LANDINGS_KEPT_FOR_MS = 30 * 24 * 60 * 60 * 1000;

/** A landing as the history keeps it: what it was, and whose and where. */
export interface KeptLanding extends Landing {
	/** The session and the ref, which it is kept once by. */
	readonly key: string;
	readonly session: string;
	/** The address the session signed with. */
	readonly address?: string;
	/** The quest it had loaded. */
	readonly quest?: string;
	/** The repository the change is in, as `owner/name` or its name. */
	readonly repo?: string;
	/** The machine it landed on, by its short name. */
	readonly machine?: string;
}

/** The file as it is written. */
interface History {
	readonly v: 1;
	readonly landings: readonly KeptLanding[];
}

/** Whose a landing is and where, as the peer that heard it knows. */
export interface Whose {
	readonly session: string;
	readonly address?: string;
	readonly quest?: string;
	/** The repository the session works in, when a change doesn't say. */
	readonly repo?: string;
	readonly machine?: string;
}

/** The key a landing is kept once by. */
export function keyOf(session: string, ref: string): string {
	return `${session}:${ref}`;
}

/**
 * The repository a landing names: a change's `owner/name` from its web
 * page where it has one, else the part of its ref before the `#`. A
 * plan item's ref names a document, not a repository.
 */
export function repoOf(landing: Landing): string | undefined {
	const page = landing.url?.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\//)?.[1];
	if (page) return page;
	const hash = landing.ref.lastIndexOf("#");
	if (hash <= 0) return undefined;
	const before = landing.ref.slice(0, hash);
	return /^[A-Z]+-\d{8}-[A-Z0-9]+$/.test(before) ? undefined : before;
}

/** A landing as kept, with whose it is and where. */
export function kept(landing: Landing, whose: Whose): KeptLanding {
	const repo = repoOf(landing) ?? whose.repo;
	return {
		key: keyOf(whose.session, landing.ref),
		...landing,
		session: whose.session,
		...(whose.address ? { address: whose.address } : {}),
		...(whose.quest ? { quest: whose.quest } : {}),
		...(repo ? { repo } : {}),
		...(whose.machine ? { machine: whose.machine } : {}),
	};
}

/** This machine's short name, as the history names it. */
export function thisMachine(): string {
	return hostname().split(".")[0] ?? hostname();
}

/** The landings still kept at `now`, newest first. */
export function keptAt(
	landings: readonly KeptLanding[],
	now: number,
): KeptLanding[] {
	return landings
		.filter((one) => now - Date.parse(one.at) < LANDINGS_KEPT_FOR_MS)
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Whether a value reads as a kept landing. */
function isKept(value: unknown): value is KeptLanding {
	if (typeof value !== "object" || value === null) return false;
	return (
		"key" in value &&
		typeof value.key === "string" &&
		"session" in value &&
		typeof value.session === "string" &&
		"ref" in value &&
		typeof value.ref === "string" &&
		"at" in value &&
		typeof value.at === "string"
	);
}

/** What the file holds, or nothing kept when it is missing or unreadable. */
async function readHistory(path: string): Promise<KeptLanding[]> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof value !== "object" || value === null) return [];
		if (!("landings" in value) || !Array.isArray(value.landings)) return [];
		return value.landings.filter(isKept);
	} catch {
		// No history yet, or one a crash left half written (never, since it
		// is replaced whole): it starts again from this landing.
		return [];
	}
}

/** Change the history at `dir` under its lock, pruned to the month. */
async function changeHistory(
	dir: string,
	change: (landings: KeptLanding[]) => KeptLanding[],
	now: number,
): Promise<void> {
	const path = join(dir, LANDING_HISTORY_FILE);
	await withFileLock(path, async () => {
		const history: History = {
			v: 1,
			landings: keptAt(change(await readHistory(path)), now),
		};
		writeWhole(path, `${JSON.stringify(history, null, 2)}\n`);
	});
}

/** Keep `landing` in the history at `dir`, in place of any of its key. */
export async function keepLanding(
	dir: string,
	landing: KeptLanding,
	now: number = Date.now(),
): Promise<void> {
	await changeHistory(
		dir,
		(landings) => [
			landing,
			...landings.filter((one) => one.key !== landing.key),
		],
		now,
	);
}

/** What keeps a peer's landings once its presence no longer does. */
export interface LandingKeeper {
	landed(landing: Landing, whose: Whose): void;
	unlanded(session: string, ref: string): void;
}

/**
 * A keeper writing to the history at `dir`, naming this machine. A write
 * that fails is let go: the landing still stands in the presence, the
 * plan and the pull request, and the next one writes the file again.
 */
export function landingKeeper(
	dir: string,
	machine: string = thisMachine(),
	now: () => number = Date.now,
): LandingKeeper {
	const quietly = (write: Promise<void>) => {
		write.catch(() => {
			// See above: one lost write costs one history line, nothing more.
		});
	};
	return {
		landed(landing, whose) {
			quietly(keepLanding(dir, kept(landing, { machine, ...whose }), now()));
		},
		unlanded(session, ref) {
			quietly(forgetLanding(dir, keyOf(session, ref), now()));
		},
	};
}

/** Take back the landing of `key`, as a plan item unticked is. */
export async function forgetLanding(
	dir: string,
	key: string,
	now: number = Date.now(),
): Promise<void> {
	await changeHistory(
		dir,
		(landings) => landings.filter((one) => one.key !== key),
		now,
	);
}
