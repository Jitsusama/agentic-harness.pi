/**
 * Whether the person is away from the machine, shared by every session
 * on it.
 *
 * Being away is something true of a person, not of one terminal. When
 * the person leaves, every session they left running should stop
 * waiting on them, not only the one they happened to say it in; and
 * when they come back and type in any window, every session should
 * know, so none goes on holding approvals for someone who is sitting
 * right there. Before this file each session kept its own absence, and
 * the person had to say they were leaving once per window.
 *
 * So one small file says whether the person is away and since when.
 * The session where they leave or come back writes it; every session
 * watches it and follows. Only the fact of the absence is shared: what
 * each session held and decided stays its own, since only that session
 * can make those calls again.
 *
 * The file is written by rename, so a reader sees the old word or the
 * new one and never half of either; the directory is watched rather
 * than the file, because a rename replaces the file a watch would hold.
 * A missing or unreadable file says nothing, which leaves each session
 * as it was rather than ending or starting an absence on a guess.
 */

import {
	type FSWatcher,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { stateDir } from "../paths.ts";

/** What the machine says about the person. */
export interface MachineWord {
	/** The absence under way, or undefined when the person is here. */
	readonly away?: { readonly since: string; readonly goal?: string };
	/** When this word was written, as an ISO timestamp. */
	readonly at: string;
}

/** Where the machine's word is kept. */
export function machineAwayPath(): string {
	return join(stateDir("away-workflow"), "machine.json");
}

function isWord(value: unknown): value is MachineWord {
	if (typeof value !== "object" || value === null) return false;
	if (!("at" in value) || typeof value.at !== "string") return false;
	if (!("away" in value) || value.away === undefined || value.away === null) {
		return true;
	}
	const away = value.away;
	return (
		typeof away === "object" &&
		"since" in away &&
		typeof away.since === "string" &&
		(!("goal" in away) ||
			away.goal === undefined ||
			typeof away.goal === "string")
	);
}

/** The machine's word, or undefined when nothing readable is there. */
export function readMachineWord(
	path: string = machineAwayPath(),
): MachineWord | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	try {
		const value: unknown = JSON.parse(text);
		if (!isWord(value)) return undefined;
		// JSON has no undefined, so a present person is stored as null.
		return value.away ? value : { at: value.at };
	} catch {
		return undefined;
	}
}

/**
 * Say to every session that the person is away, with the absence's
 * start and goal, or that they are here when `away` is undefined.
 * Best-effort: a session that cannot write still keeps its own
 * absence, which is how it behaved before the word was shared.
 */
export function publishMachineWord(
	away: { since: string; goal?: string } | undefined,
	now: Date = new Date(),
	path: string = machineAwayPath(),
): void {
	const word = {
		away: away ? { since: away.since, goal: away.goal } : null,
		at: now.toISOString(),
	};
	const tmp = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`,
	);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(word)}\n`);
		renameSync(tmp, path);
	} catch {
		try {
			unlinkSync(tmp);
		} catch {
			// Nothing was written, or it is already gone.
		}
	}
}

/**
 * Be told each time the machine's word changes. Returns a disposer.
 * The callback gets the word as it reads now; it can be called more
 * than once for one write, so whatever it does must be idempotent.
 */
export function watchMachineWord(
	onChange: (word: MachineWord | undefined) => void,
	path: string = machineAwayPath(),
): () => void {
	const name = basename(path);
	let watcher: FSWatcher | undefined;
	try {
		mkdirSync(dirname(path), { recursive: true });
		watcher = watch(dirname(path), { persistent: false }, (_event, file) => {
			if (file !== null && file !== name) return;
			onChange(readMachineWord(path));
		});
		// A directory removed under the watch ends it with an error; the
		// session keeps its own absence, as it would with no file at all.
		watcher.on("error", () => watcher?.close());
	} catch {
		return () => {};
	}
	return () => watcher?.close();
}

/** What a session should do to agree with the machine. */
export type Agreement =
	| { readonly kind: "nothing" }
	| { readonly kind: "go-away"; readonly since: string; readonly goal?: string }
	| { readonly kind: "come-back" };

/**
 * Compare the machine's word with this session's own absence.
 *
 * A word saying the person is here ends an absence only when it was
 * written after that absence began: a session that went away after
 * the person last typed must not be called back by the older word. No
 * word at all leaves the session as it is.
 */
export function agree(
	word: MachineWord | undefined,
	local: { since?: string; goal?: string },
): Agreement {
	if (!word) return { kind: "nothing" };
	if (word.away) {
		const sameGoal =
			word.away.goal === undefined || word.away.goal === local.goal;
		if (local.since !== undefined && sameGoal) return { kind: "nothing" };
		return {
			kind: "go-away",
			since: word.away.since,
			...(word.away.goal !== undefined ? { goal: word.away.goal } : {}),
		};
	}
	if (local.since !== undefined && word.at > local.since) {
		return { kind: "come-back" };
	}
	return { kind: "nothing" };
}
