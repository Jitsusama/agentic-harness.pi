/**
 * The branches of worktrees the sweep took from live sessions, kept at
 * their heads while those sessions live.
 *
 * A worktree a live session left clean, its branch on a remote, may go
 * (`sweep-idle.ts`), since asking for it again checks its branch out
 * afresh. That holds only while the branch stands where it was: the
 * branch sweep drops a branch trunk holds once it has sat a day, and a
 * pull request's branch on origin goes when it merges. So each take
 * leaves a note naming the checkout, branch and head, which the branch
 * sweep honours, and once every session it names has ended the note goes
 * and the branch with it, if trunk holds all of it.
 */

import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Exec } from "../exec/index.ts";
import { dropMergedBranch } from "./merged-branch.ts";

/**
 * The folder beside the sweep's lock that keeps the notes, named once so
 * the sweep that writes them and the listing that tells of them agree.
 */
export const KEPT_BRANCHES = "kept-branches";

/** A branch kept for the sessions whose worktree on it was taken. */
export interface KeptBranch {
	/** The main checkout the branch lives in. */
	checkout: string;
	branch: string;
	/** The commit it pointed at when its tree went. */
	commit: string;
	/** The path its tree stood at. */
	path: string;
	/** The sessions whose record named the tree. */
	sessions: string[];
	/** When its tree went, in milliseconds since the epoch. */
	takenAt: number;
}

/** The file a note for `checkout`'s `branch` is kept in, under `dir`. */
function noteFile(dir: string, checkout: string, branch: string): string {
	const name = createHash("sha256")
		.update(`${checkout}\0${branch}`)
		.digest("hex");
	return join(dir, `${name.slice(0, 32)}.json`);
}

/** Whether `value` reads as a note this module wrote. */
function isKeptBranch(value: unknown): value is KeptBranch {
	if (typeof value !== "object" || value === null) return false;
	const field = (name: string): unknown => Reflect.get(value, name);
	const sessions = field("sessions");
	return (
		["checkout", "branch", "commit", "path"].every(
			(name) => typeof field(name) === "string",
		) &&
		typeof field("takenAt") === "number" &&
		Array.isArray(sessions) &&
		sessions.every((one) => typeof one === "string")
	);
}

/** Write a note keeping `kept.branch` in `kept.checkout`, under `dir`. */
export function keepBranch(dir: string, kept: KeptBranch): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		noteFile(dir, kept.checkout, kept.branch),
		JSON.stringify(kept, null, 2),
		"utf8",
	);
}

/** Every note under `dir`, with the file each is in; none where none can be read. */
export function keptBranches(
	dir: string,
): { file: string; kept: KeptBranch }[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		// No folder yet: no tree has been taken from a live session.
		return [];
	}
	const notes: { file: string; kept: KeptBranch }[] = [];
	for (const name of names) {
		const file = join(dir, name);
		try {
			const kept: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (isKeptBranch(kept)) notes.push({ file, kept });
		} catch {
			// A note half-written or unreadable keeps nothing; the next
			// take of that branch writes it whole again.
		}
	}
	return notes;
}

/**
 * The notes under `dir` naming `session`, oldest first: the worktrees
 * the sweep took from it, so it can be told which went and how to have
 * each again.
 */
export function branchesKeptForSession(
	dir: string,
	session: string,
): KeptBranch[] {
	return keptBranches(dir)
		.map(({ kept }) => kept)
		.filter((kept) => kept.sessions.includes(session))
		.sort((a, b) => a.takenAt - b.takenAt);
}

/**
 * The branches the notes under `dir` keep, by checkout, once each note
 * whose sessions have all ended is let go: its branch dropped if trunk
 * holds all of it, as release drops one, and the note removed. With
 * `live` unknown every note stands, since ending one early could lose
 * the head a session asks for.
 */
export async function branchesKeptFor(
	exec: Exec,
	dir: string,
	live: ReadonlySet<string> | undefined,
): Promise<Map<string, Set<string>>> {
	const kept = new Map<string, Set<string>>();
	for (const { file, kept: note } of keptBranches(dir)) {
		const ended =
			live !== undefined && !note.sessions.some((session) => live.has(session));
		if (ended) {
			await dropMergedBranch(exec, note.checkout, note.branch);
			rmSync(file, { force: true });
			continue;
		}
		const branches = kept.get(note.checkout) ?? new Set<string>();
		branches.add(note.branch);
		kept.set(note.checkout, branches);
	}
	return kept;
}
