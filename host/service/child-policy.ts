/**
 * Which conversations a host runs in children of their own (children.ts),
 * as a file beside the host's state says: `{"v":1,"all":true}` moves
 * every one, an open or adopt among them, and `"sessions": [ids]` moves
 * only those, as each next wakes or the host next starts. With no file,
 * or one it can't read, nothing moves, so a host whose machine has no
 * child unit runs every conversation itself, as before.
 *
 * The file is read as it changes, never per decision, so asking costs
 * the host's thread nothing. Taking a conversation out of it moves it
 * back: its child runs on until it parks, closes or is released, and
 * the host runs it again from its next wake.
 */

import { watch } from "node:fs";
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
	/** Stop following the file. */
	close(): void;
}

const POLICY = z.strictObject({
	v: z.literal(1),
	all: z.boolean().default(false),
	sessions: z.array(z.string()).default([]),
});

type Read = z.infer<typeof POLICY>;

const NONE: Read = { v: 1, all: false, sessions: [] };

/** Where the host keyed `key` keeps its child policy. */
export function childPolicyFile(key: string): string {
	return join(stateDir("host-service"), key, "children.json");
}

/** Whether an error says the file isn't there. */
function missing(error: unknown): boolean {
	return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

async function readPolicy(
	file: string,
	report: (error: unknown) => void,
): Promise<Read> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (!missing(error)) report(error);
		return NONE;
	}
	try {
		return POLICY.parse(JSON.parse(text));
	} catch (error) {
		report(new Error(`${file} names no children: ${String(error)}`));
		return NONE;
	}
}

/**
 * The policy in `file`, read now and again each time it changes; what
 * it can't read moves nothing and goes to `report`.
 */
export async function watchedChildPolicy(
	file: string,
	report: (error: unknown) => void,
): Promise<ChildPolicy> {
	// Made now, so a file written later is seen.
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	let read = await readPolicy(file, report);
	let named = new Set(read.sessions);
	// Each read waits on the one before, so the last change read wins.
	let reading = Promise.resolve();
	const reread = () => {
		reading = reading.then(async () => {
			read = await readPolicy(file, report);
			named = new Set(read.sessions);
		});
	};
	// The folder, since a file written whole is renamed into place.
	const watcher = watch(dirname(file), (_event, name) => {
		if (name === null || name === basename(file)) reread();
	});
	watcher.on("error", report);
	return {
		moves: (sessionId) => read.all || named.has(sessionId),
		opens: () => read.all,
		close: () => watcher.close(),
	};
}
