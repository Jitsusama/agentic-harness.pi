/**
 * The fence's first stage for what `quest spawn` starts: once spawns
 * join the stage (a file under it says so), a fresh spawn is listed, so
 * its pi starts fenced; until then, nothing is; a reopen never is, since a reopened
 * attended session would fence Joel's own typing, and joins only at the
 * everyone stage (ISXEG8 [1309c590]). A listing that can't be written
 * leaves the spawn to start as before the stage, rather than not at all,
 * and a line in the system's log saying so (fence-log.ts).
 */

import {
	type DeclarationRead,
	fenceDeclared,
	undeclaredRuns,
} from "../../../lib/internal/fence/fence-declaration.ts";
import {
	codeOf,
	recordUnlisted,
} from "../../../lib/internal/fence/fence-log.ts";
import {
	listForStage,
	listSpawnForStage,
	spawnsJoin,
} from "../../../lib/internal/fence/fence-stage.ts";
import { resumedBy } from "./spawn-launcher.ts";

/** What a spawn is, as far as the stage goes. */
export interface StagedSpawn {
	readonly questId: string;
	/** The session it reopens, picked for it, if any. */
	readonly resuming?: string | undefined;
	/** The command the call names, which may reopen one itself. */
	readonly command?: string | undefined;
	readonly dryRun?: boolean | undefined;
}

/** What a spawn says of its fence, before it is known where it starts. */
export interface AskedFence {
	/** The word the call gives. */
	readonly fence?: string | undefined;
	/** The word its quest's README gives. */
	readonly quest: unknown;
	/** The environment of the session spawning it. */
	readonly parent: Readonly<Record<string, string | undefined>>;
	readonly dryRun?: boolean | undefined;
}

/**
 * The fence a spawn tells the node it runs in, as it would start fresh
 * here: what the call or its quest declares, else what it runs, which
 * counts the stage taking it once spawns join. Asked before the node
 * places it, so it lists nothing; `declarationSettled` corrects it once
 * the stage has listed it, or not.
 */
export function spawnFence(asked: AskedFence): DeclarationRead {
	const staged = !asked.dryRun && spawnsJoin();
	const runs = undeclaredRuns({ parent: asked.parent, staged });
	return fenceDeclared(asked.fence, asked.quest, runs);
}

/** Whether a spawn reopens a session, picked or by its command. */
function reopens(spawn: StagedSpawn): boolean {
	return (
		spawn.resuming !== undefined || resumedBy(spawn.command ?? "") !== undefined
	);
}

/** Why a spawn was listed, as its listing says. */
function whyOf(spawn: StagedSpawn): string {
	return `quest spawn for ${spawn.questId}`;
}

/**
 * List a fresh spawn for the stage, answering the token its environment
 * names it by (`STAGE_VARIABLE`), or nothing before spawns join, for a
 * reopen, a dry run or a listing that couldn't be written.
 */
export function stagedSpawn(spawn: StagedSpawn): string | undefined {
	if (reopens(spawn) || spawn.dryRun || !spawnsJoin()) return undefined;
	try {
		return listSpawnForStage(whyOf(spawn));
	} catch (error) {
		// Unlisted, it starts as every session outside the stage does.
		void recordUnlisted({
			kind: "spawn",
			session: process.env.PI_SESSION_ID,
			quest: spawn.questId,
			error: codeOf(error),
		});
		return undefined;
	}
}

/** List a fresh spawn the launcher starts by the id it hands on alone. */
export function stagedById(session: string, spawn: StagedSpawn): void {
	try {
		listForStage(session, whyOf(spawn));
	} catch (error) {
		// Unlisted by id, it starts as every session outside the stage does.
		void recordUnlisted({
			kind: "id",
			session,
			quest: spawn.questId,
			error: codeOf(error),
		});
	}
}
