/**
 * The other machines where a quest's scratch may remain once it is
 * sealed here.
 *
 * A conclude or retire removes the quest's scratch folder on the machine
 * it runs on, and nowhere else: on 9 November 718 GB of a quest
 * concluded on optimus was still on the Mac, where its sessions had run,
 * and nothing had said so (5FWIUS). This machine can't reach the other's
 * disk, which may be asleep, so it names each machine that may hold some
 * and leaves the removal to that machine.
 *
 * Two records say where a quest's scratch went. The quest's own README
 * names the host of every session that drove it, and a session keeps its
 * quest's scratch on the machine it runs on. Mycelium's share record of
 * the quest names each machine holding a copy of the scratch folders a
 * share named; its `record/` files are the quest's record, which a seal
 * keeps, so they don't count.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QuestSession } from "../../quest/types.ts";

/** The prefix of a share record's entries that are the quest's record. */
const RECORD_PREFIX = "record/";

/**
 * Every machine other than `here` that a session of the quest ran on, or
 * a share copied its scratch to, sorted by name.
 */
export function machinesHoldingScratch(
	sessions: readonly QuestSession[],
	here: string,
	shared: readonly string[] = [],
): string[] {
	const machines = new Set<string>(shared);
	for (const session of sessions) {
		if (session.process?.hostId) machines.add(session.process.hostId);
		if (session.terminal?.hostId) machines.add(session.terminal.hostId);
	}
	machines.delete(here);
	return [...machines].sort();
}

/**
 * The machines mycelium's share record says hold a copy of the quest's
 * scratch, read from its state folder; none when the quest was never
 * shared, or shared its record alone.
 */
export function sharedScratchMachines(
	questId: string,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			readFileSync(
				join(state, "mycelium", "shared", `${questId}.json`),
				"utf8",
			),
		);
	} catch {
		// Never shared, or a record mycelium is mid-way writing: either
		// way it names no machine this can trust.
		return [];
	}
	const files = asRecord(asRecord(parsed)?.files);
	if (!files) return [];
	const machines = new Set<string>();
	for (const [path, entry] of Object.entries(files)) {
		if (path.startsWith(RECORD_PREFIX)) continue;
		const version = asRecord(asRecord(entry)?.version);
		for (const machine of Object.keys(version ?? {})) machines.add(machine);
	}
	return [...machines];
}

/**
 * What a seal says of the scratch it couldn't reach, or nothing when no
 * other machine holds any.
 */
export function scratchElsewhereSaid(
	machines: readonly string[],
): string | undefined {
	if (machines.length === 0) return undefined;
	const named = listed(machines);
	return `Its scratch may remain on ${named}, where its sessions ran or a share copied it; this machine removes only its own, so ${machines.length === 1 ? "that machine keeps it" : "those machines keep theirs"} until removed there.`;
}

function listed(names: readonly string[]): string {
	if (names.length <= 2) return names.join(" and ");
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
