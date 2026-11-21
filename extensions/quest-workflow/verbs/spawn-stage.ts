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
	type DeclaredFence,
	declarationSettled,
	type FenceDeclaration,
	fenceDeclared,
	type SpawnSettled,
	sandboxFor,
	UNFENCED,
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
}

/**
 * The fence a spawn tells the node it runs in, as it would start fresh
 * here: what the call or its quest declares, else what it runs, which
 * counts the stage taking it once spawns join, on a dry run too, so it
 * says what the spawn it previews would. Asked before the node places
 * it, so it lists nothing; `declarationSettled` corrects it once it is
 * known how the spawn starts.
 */
export function spawnFence(asked: AskedFence): DeclarationRead {
	const runs = undeclaredRuns({ parent: asked.parent, staged: spawnsJoin() });
	return fenceDeclared(asked.fence, asked.quest, runs);
}

/**
 * Whether a spawn reopens a session, picked or by its command: the one
 * test for both the stage and the sandbox a fresh spawn is given, so
 * neither a reopen by command gains a sandbox nor a fresh pi with a
 * command of its own loses one.
 */
export function reopens(spawn: StagedSpawn): boolean {
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
	if (spawn.dryRun || !wouldStage(spawn)) return undefined;
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

/** What a spawn's placement ask knows of whether it reopens. */
export interface PlacementAsked {
	/** The command the call gives, if any. */
	readonly command?: string | undefined;
	/** Whether a session of the quest would resume, if nothing else is said. */
	readonly resumes: boolean;
}

/** What a shell reads as more than one program, or as a word it fills in. */
const SHELL_OPERATOR = /[;&|`$()<>\n]/;

/** pi's flags that load none of the package, its fence included. */
const WITHOUT_EXTENSIONS = new Set(["--no-extensions", "-ne"]);

/**
 * Whether `command` runs pi alone, the one program the fence's variables
 * reach: none given starts pi, and else its first word must name it and
 * nothing may follow it in another program (`pi && bash`), nor may it
 * leave out the extensions that lay the fence (`pi --no-extensions`). A
 * command that starts pi another way (through env or a wrapper) counts
 * as not, so it claims less than it may run, never more.
 */
export function runsPi(command: string | undefined): boolean {
	const trimmed = command?.trim() ?? "";
	if (SHELL_OPERATOR.test(trimmed)) return false;
	const [first = "", ...flags] = trimmed.split(/\s+/);
	if (flags.some((flag) => WITHOUT_EXTENSIONS.has(flag))) return false;
	return first === "" || first.split("/").pop() === "pi";
}

/**
 * The fence a spawn tells the node when asking where it runs, asked
 * before it is known whether it reopens or where it lands: one that may
 * reopen, which is given no sandbox, or runs something other than pi
 * claims none, and so does the fence, declared or not, which a start on
 * another machine may run without (an older pi there, or a Mac, lifts
 * it), since under-claiming is safe. Strict, which no pi lifts, stays.
 */
export function placementFence(
	fence: FenceDeclaration,
	asked: PlacementAsked,
): FenceDeclaration {
	const command = asked.command?.trim() ?? "";
	const mayReopen =
		resumedBy(command) !== undefined || (asked.resumes && command === "");
	const mayLandElsewhere = fence.kind === "fence";
	return mayReopen || mayLandElsewhere || !runsPi(command) ? UNFENCED : fence;
}

/** A spawn once it is known where it starts and what listed it. */
export interface StartedSpawn extends StagedSpawn {
	/** Whether the stage listed it (`stagedSpawn`). */
	readonly listed: boolean;
	/** Whether a node holds it, on this machine or another. */
	readonly held: boolean;
	/** Whether it starts on this machine, held or not. */
	readonly here: boolean;
}

/**
 * How `spawn` starts, for the claim it settles: a dry run is staged as
 * the stage would list it; the token reaches what opens here, in a
 * terminal, the launcher or a host, but never a held start, even on this
 * machine. A declared fence's mark goes wherever its `PI_SANDBOX` does,
 * but is kept only by a pi of this install on Linux: a start on another
 * machine may meet an older pi, which lifts it, and on a Mac this
 * package's fence refuses every command, so pi-fence lays it instead.
 */
export function spawnSettled(
	spawn: StartedSpawn,
	platform: NodeJS.Platform = process.platform,
): SpawnSettled {
	return {
		staged: spawn.dryRun ? wouldStage(spawn) : spawn.listed,
		carried: !spawn.held,
		reopens: reopens(spawn),
		pi: runsPi(spawn.command),
		kept: spawn.here && platform === "linux",
	};
}

/** A started spawn's fence: what it claims, and the sandbox it is handed. */
export interface SpawnFenced {
	/** The fence it tells the node, never more than is sure to run. */
	readonly claim: FenceDeclaration;
	/** The `PI_SANDBOX` it starts with, if any. */
	readonly sandbox: DeclaredFence | undefined;
}

/**
 * The fence a started spawn claims and the sandbox it is handed. They
 * part where a pi may lift what it was given: a declared fence held on
 * another machine or opened on a Mac is still handed on, so whatever
 * keeps it there does, but claimed as none. A reopen keeps its own, as
 * the stage leaves a reopen alone, so it is handed nothing.
 */
export function spawnFenced(
	declared: FenceDeclaration,
	spawn: StartedSpawn,
	platform: NodeJS.Platform = process.platform,
): SpawnFenced {
	return {
		claim: declarationSettled(declared, spawnSettled(spawn, platform)),
		sandbox: reopens(spawn) ? undefined : sandboxFor(declared),
	};
}

/** Whether the stage would list `spawn`, dry run or not. */
export function wouldStage(spawn: StagedSpawn): boolean {
	return !reopens(spawn) && spawnsJoin();
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
