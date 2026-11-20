/**
 * The machines the nodes have named, kept in a file so that a session
 * started or reloaded while no node answers still knows them: knowing
 * only its own, "restart equilibrius" would read as restarting
 * something else and go through, just when the guard means to refuse.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

/**
 * The machines `read` names together with those kept in `file`, which
 * keeps them all when that adds any. A machine once named stays: one
 * known too many reads one more ask, which the node then judges, while
 * one forgotten lets its restart through unasked.
 */
export function rememberMachines(
	file: string,
	read: readonly string[],
): string[] {
	const kept = machinesKept(file);
	const all = [...new Set([...kept, ...read.filter(isMachineName)])];
	if (all.length === kept.length) return all;
	try {
		mkdirSync(dirname(file), { recursive: true });
		const writing = `${file}.${process.pid}.tmp`;
		writeFileSync(writing, `${JSON.stringify(all)}\n`);
		renameSync(writing, file);
	} catch {
		// A state folder that can't be written: this answer still names them all.
	}
	return all;
}
