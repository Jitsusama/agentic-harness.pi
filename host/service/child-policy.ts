/**
 * Which conversations a host runs in children of their own (children.ts),
 * as a file beside the host's state says: `{"v":1,"all":true}` moves
 * every one, an open or adopt among them, and `"sessions": [ids]` moves
 * only those, as each next wakes or the host next starts. `"spares": true`
 * keeps one warm spare child (spare.ts) waiting for the next resume to
 * take, off by default, and only while the file moves something: beside
 * `"sessions": []` no start could ever take it. With no file,
 * nothing moves, so a host whose machine has no child unit runs every
 * conversation itself, as before. One it can't read keeps what it last
 * read, since an editor's write is empty for a moment; a folder it can't
 * make or watch moves nothing and is said, never failing the host.
 *
 * The file is read as it changes, never per decision, so asking costs
 * the host's thread nothing. Taking a conversation out of it moves it
 * back: its child runs on until it parks, closes or is released, and
 * the host runs it again from its next wake.
 */

import { type FSWatcher, watch } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { stateDir } from "../../lib/internal/paths.ts";

/** Which conversations go to children, as the host last read it. */
export interface ChildPolicy {
	/** Whether this conversation runs in a child as it next wakes or starts. */
	moves(sessionId: string): boolean;
	/** Whether a conversation opened or adopted now starts in a child. */
	opens(): boolean;
	/** Whether the host keeps a warm spare child for its next resume. */
	spares?(): boolean;
	/** Stop following the file. */
	close(): void;
}

const POLICY = z.strictObject({
	v: z.literal(1),
	all: z.boolean().default(false),
	sessions: z.array(z.uuid()).default([]),
	spares: z.boolean().default(false),
});

type Read = z.infer<typeof POLICY>;

const NONE: Read = { v: 1, all: false, sessions: [], spares: false };

/** Where the host keyed `key` keeps its child policy. */
export function childPolicyFile(key: string): string {
	return join(stateDir("host-service"), key, "children.json");
}

/** Whether an error says the file isn't there. */
function missing(error: unknown): boolean {
	return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

/** The policy in `file`: none when it is missing, `kept` when unreadable. */
async function readPolicy(
	file: string,
	kept: Read,
	report: (error: unknown) => void,
): Promise<Read> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (missing(error)) return NONE;
		report(error);
		return kept;
	}
	try {
		return POLICY.parse(JSON.parse(text));
	} catch (error) {
		report(
			new Error(
				`${file} can't be read, so the last policy read stands: ${String(error)}`,
			),
		);
		return kept;
	}
}

/**
 * The policy in `file`, read once its folder is watched and again each
 * time it changes, so no change made meanwhile is missed. What it can't
 * read goes to `report`, as does a folder it can't watch, which leaves
 * nothing moving.
 */
export async function watchedChildPolicy(
	file: string,
	report: (error: unknown) => void,
): Promise<ChildPolicy> {
	let read = NONE;
	let named = new Set<string>();
	// Each read waits on the one before, so the last change read wins.
	let reading = Promise.resolve();
	const reread = () => {
		reading = reading.then(async () => {
			read = await readPolicy(file, read, report);
			named = new Set(read.sessions);
		});
		return reading;
	};
	let watcher: FSWatcher;
	try {
		// Made now, so a file written later is seen.
		await mkdir(dirname(file), { recursive: true, mode: 0o700 });
		// The folder, since a file written whole is renamed into place.
		watcher = watch(dirname(file), (_event, name) => {
			if (name === null || name === basename(file)) void reread();
		});
	} catch (error) {
		report(
			new Error(
				`${file} can't be watched, so every conversation stays in the host: ${String(error)}`,
			),
		);
		return {
			moves: () => false,
			opens: () => false,
			spares: () => false,
			close: () => undefined,
		};
	}
	watcher.on("error", (error) =>
		report(
			new Error(
				`${file} is no longer followed; its last read stands: ${String(error)}`,
			),
		),
	);
	await reread();
	return {
		moves: (sessionId) => read.all || named.has(sessionId),
		opens: () => read.all,
		spares: () => read.spares && (read.all || named.size > 0),
		close: () => watcher.close(),
	};
}
