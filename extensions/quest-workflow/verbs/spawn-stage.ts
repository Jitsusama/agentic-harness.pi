/**
 * The fence's first stage for what `quest spawn` starts: a fresh spawn
 * is listed, so its pi starts fenced; a reopen isn't, since a reopened
 * attended session would fence Joel's own typing, and joins only at the
 * everyone stage (ISXEG8 [1309c590]). A listing that can't be written
 * leaves the spawn to start as before the stage, rather than not at all.
 */

import {
	listForStage,
	listSpawnForStage,
} from "../../../lib/internal/fence-stage.ts";
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
 * names it by (`STAGE_VARIABLE`), or nothing for a reopen, a dry run or
 * a listing that couldn't be written.
 */
export function stagedSpawn(spawn: StagedSpawn): string | undefined {
	if (reopens(spawn) || spawn.dryRun) return undefined;
	try {
		return listSpawnForStage(whyOf(spawn));
	} catch {
		// Unlisted, it starts as every session outside the stage does.
		return undefined;
	}
}

/** List a fresh spawn the launcher starts by the id it hands on alone. */
export function stagedById(session: string, spawn: StagedSpawn): void {
	try {
		listForStage(session, whyOf(spawn));
	} catch {
		// Unlisted by id, it starts as every session outside the stage does.
	}
}
