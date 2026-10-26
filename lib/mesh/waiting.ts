/**
 * Waiting: what a quest has waiting on its person, kept where the
 * desktop's launcher reads it.
 *
 * Each quest keeps one file, `<folder>/<ADDRESS>.json`, so no session
 * writes another's and none waits on its orchestrator to relay it. The
 * launcher (core.nix's Steward.qml) reads every file in the folder for
 * its Waiting on you, and raises a notice for an item that is ready.
 * The shape is the one `mission-wait` wrote by hand from a shell
 * (core.nix, modules/mission/wait.sh): the quest, when it changed, and
 * its items, each with an id, what it is, why it waits, how many
 * minutes it takes, when, the window it is done in, its quest, and
 * whether he can do it now. The file outlives the session that wrote
 * it, so what waits on him is not lost when a session ends; presence
 * only mirrors it.
 *
 * Each file is written whole under a temporary name beside it and
 * renamed in, so a reader never sees half of one, and a file left with
 * no items is removed.
 */

import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { questAddress } from "./address.ts";

/** One thing a quest has waiting on its person. */
export interface WaitingItem {
	/** Its own name within the quest, so it can be replaced or settled. */
	readonly id: string;
	/** What he is to do, in a few words. */
	readonly title: string;
	/** Why it waits on him rather than on an agent. */
	readonly why: string;
	/** How many minutes it takes him. */
	readonly minutes: number;
	/** When he can do it, in his words ("now", "tonight", "after 08:00"). */
	readonly when: string;
	/** The window it is done in, by its exact title, or none. */
	readonly window: string | null;
	/** The quest it waits for. */
	readonly quest: string;
	/** Whether he can do it now, which raises a notice. */
	readonly ready: boolean;
}

/** A quest's file, as the launcher reads it. */
interface WaitingFile {
	readonly updated: string;
	readonly quest: string;
	readonly items: readonly WaitingItem[];
}

/** The file a quest's items are kept in. */
export function waitingFile(folder: string, quest: string): string {
	return join(folder, `${questAddress(quest)}.json`);
}

/** What a quest has waiting now, oldest first. */
export function waitingOf(folder: string, quest: string): WaitingItem[] {
	try {
		const read: unknown = JSON.parse(
			readFileSync(waitingFile(folder, quest), "utf8"),
		);
		const items = (read as { items?: unknown } | null)?.items;
		return Array.isArray(items) ? items.filter(isWaitingItem) : [];
	} catch {
		// No file, or one being replaced: nothing waits.
		return [];
	}
}

/**
 * Say an item waits, in place of any with its id, so saying it again
 * with `ready` says it has become ready. Answers what waits now.
 */
export function addWaiting(
	folder: string,
	item: WaitingItem,
	now = new Date(),
): WaitingItem[] {
	const held = waitingOf(folder, item.quest);
	const items = held.some((one) => one.id === item.id)
		? held.map((one) => (one.id === item.id ? item : one))
		: [...held, item];
	write(folder, item.quest, items, now);
	return items;
}

/** Say an item no longer waits. Answers what waits now. */
export function settleWaiting(
	folder: string,
	quest: string,
	id: string,
	now = new Date(),
): WaitingItem[] {
	const items = waitingOf(folder, quest).filter((one) => one.id !== id);
	write(folder, quest, items, now);
	return items;
}

function write(
	folder: string,
	quest: string,
	items: readonly WaitingItem[],
	now: Date,
): void {
	const path = waitingFile(folder, quest);
	if (items.length === 0) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(folder, { recursive: true });
	const file: WaitingFile = { updated: now.toISOString(), quest, items };
	const temporary = join(
		folder,
		`.${questAddress(quest)}.${process.pid}.${now.getTime()}.tmp`,
	);
	writeFileSync(temporary, JSON.stringify(file, null, 2));
	renameSync(temporary, path);
}

function isWaitingItem(value: unknown): value is WaitingItem {
	if (typeof value !== "object" || value === null) return false;
	const one = value as Record<string, unknown>;
	return (
		typeof one.id === "string" &&
		typeof one.title === "string" &&
		typeof one.why === "string" &&
		typeof one.minutes === "number" &&
		typeof one.when === "string" &&
		(one.window === null || typeof one.window === "string") &&
		typeof one.quest === "string" &&
		typeof one.ready === "boolean"
	);
}
