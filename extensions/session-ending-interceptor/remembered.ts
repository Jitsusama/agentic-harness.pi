/**
 * The machines the nodes have named, kept in a file so that a session
 * started or reloaded while no node answers still knows them: knowing
 * only its own, "restart equilibrius" would read as restarting
 * something else and go through, just when the guard means to refuse.
 *
 * Every session on the machine writes the one file, so each addition
 * reads and writes it under the package's file lock: two processes
 * adding at once would otherwise each lay their list over the other's
 * and drop a machine.
 */

import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withFileLock } from "../../lib/core/internal/file-lock.ts";
import { isMachineName } from "../../lib/internal/machine/machine.ts";

/** Where the machines are kept, under the state folder `env` names. */
export function rememberedMachinesFile(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(
		state,
		"pi",
		"agentic-harness.pi",
		"session-ending",
		"machines.json",
	);
}

/** The machines kept in `file`; none when it can't be read. */
function machinesKept(file: string): string[] {
	try {
		const kept: unknown = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(kept) ? kept.filter(isMachineName) : [];
	} catch {
		// Nothing kept yet, or a file nobody can parse: no machine is known.
		return [];
	}
}

/** The machines `kept` with those `read` names, in that order. */
function together(kept: readonly string[], read: readonly string[]): string[] {
	return [...new Set([...kept, ...read.filter(isMachineName)])];
}

/**
 * The machines `read` names together with those kept in `file`, which
 * keeps them all when that adds any. A machine once named stays: one
 * known too many reads one more ask, which the node then judges, while
 * one forgotten lets its restart through unasked.
 */
export async function rememberMachines(
	file: string,
	read: readonly string[],
): Promise<string[]> {
	const kept = machinesKept(file);
	const all = together(kept, read);
	if (all.length === kept.length) return all;
	try {
		mkdirSync(dirname(file), { recursive: true });
		return await withFileLock(file, async () => {
			// What was read before the lock goes in too, should the file have
			// been lost or spoilt since.
			const now = together([...machinesKept(file), ...all], read);
			const writing = `${file}.${randomUUID()}.tmp`;
			try {
				writeFileSync(writing, `${JSON.stringify(now)}\n`);
				renameSync(writing, file);
			} catch (error) {
				rmSync(writing, { force: true });
				throw error;
			}
			return now;
		});
	} catch {
		// A state folder that can't be written, or a lock held past its wait:
		// this answer still names them all.
		return all;
	}
}
