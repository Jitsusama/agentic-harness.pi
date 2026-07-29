/**
 * Where drafts live between sessions.
 *
 * A review is composed over hours, sometimes across a
 * restart, and the substrate owns that storage rather than
 * leaving each consumer to invent its own. One flat directory
 * of JSON files, each holding a whole draft: legible to a
 * person who goes looking, cheap to list, and with no index to
 * fall out of step with the files it describes.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewTarget } from "../change.js";
import type { Verdict } from "../conversation.js";
import { targetKey } from "../keys.js";
import type { DraftState } from "./state.js";

/** Enough of a draft to choose between them. */
export interface DraftSummary {
	id: string;
	target: ReviewTarget;
	/** How many things the review will do. */
	itemCount: number;
	verdict?: Verdict;
	updatedAt: string;
}

/** Durable home for drafts. */
export interface DraftStore {
	save(state: DraftState): Promise<void>;
	load(id: string): Promise<DraftState | undefined>;
	/** Newest first. */
	list(): Promise<DraftSummary[]>;
	forTarget(target: ReviewTarget): Promise<DraftSummary[]>;
	remove(id: string): Promise<void>;
}

/**
 * File name for a draft. The id is folded to something safe
 * so an id carrying a slash or a pair of dots cannot name a
 * path outside the store.
 */
function fileFor(id: string): string {
	const safe = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
	return `${safe}.json`;
}

/** Read and parse one draft, or nothing if it is unreadable. */
async function readDraft(path: string): Promise<DraftState | undefined> {
	try {
		const text = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(text);
		if (!isDraftState(parsed)) return undefined;
		return parsed;
	} catch {
		// A missing file is the common case, and a half-written
		// or hand-edited one should not take the listing down.
		return undefined;
	}
}

/** Whether parsed JSON has the shape of a draft. */
function isDraftState(value: unknown): value is DraftState {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<DraftState>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.updatedAt === "string" &&
		Array.isArray(candidate.items) &&
		typeof candidate.target === "object" &&
		candidate.target !== null
	);
}

/** The summary of a draft. */
function summarize(state: DraftState): DraftSummary {
	return {
		id: state.id,
		target: state.target,
		itemCount: state.items.length,
		...(state.verdict ? { verdict: state.verdict } : {}),
		updatedAt: state.updatedAt,
	};
}

/** Open a store rooted at a directory. */
export function createDraftStore(root: string): DraftStore {
	async function everyDraft(): Promise<DraftState[]> {
		let names: string[];
		try {
			names = await readdir(root);
		} catch {
			// Nothing has been saved yet, so there is no directory.
			return [];
		}
		const drafts = await Promise.all(
			names
				.filter((name) => name.endsWith(".json"))
				.map((name) => readDraft(join(root, name))),
		);
		return drafts.filter((draft): draft is DraftState => draft !== undefined);
	}

	async function summaries(): Promise<DraftSummary[]> {
		const drafts = await everyDraft();
		return drafts
			.map(summarize)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	return {
		async save(state) {
			await mkdir(root, { recursive: true });
			const path = join(root, fileFor(state.id));
			await writeFile(path, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
		},

		async load(id) {
			return readDraft(join(root, fileFor(id)));
		},

		list: summaries,

		async forTarget(target) {
			const key = targetKey(target);
			const all = await summaries();
			return all.filter((entry) => targetKey(entry.target) === key);
		},

		async remove(id) {
			await rm(join(root, fileFor(id)), { force: true });
		},
	};
}
