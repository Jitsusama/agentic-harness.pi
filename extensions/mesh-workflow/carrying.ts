/**
 * Carrying this session's work to another machine, when the person
 * steers it to (pausing.ts's Carry): every tree the work broker holds
 * for it, its own file, the fence its commands run under and its quest's
 * remembered facts, into its quest's handover, with the done file
 * mycelium waits for written last (lib/internal/carry/carry-away.ts).
 *
 * Its run is ended first and waited out, so the file carried holds the
 * whole session. A tree that can't be carried is named on screen and the
 * rest still go; a session with no quest loaded has no handover to carry
 * into, so it refuses, and stays open.
 *
 * A carry under way holds the doors that would end the process it runs
 * in unasked (lib/internal/carry/under-way.ts lists them), but for a host
 * restart for its heap and a person's Close or /exit, which go anyway:
 * one ordered through the node
 * holds them from the order, and passes its hold in; one the person
 * asked for takes its own. A second carry of a session already being
 * carried refuses, since the first one's success closes it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnExec } from "../../lib/core/exec/index.ts";
import { carryAway } from "../../lib/internal/carry/carry-away.ts";
import { fenceKindOf } from "../../lib/internal/carry/fence.ts";
import { handoverOf } from "../../lib/internal/carry/handover.ts";
import { type CarriedNote, notesOf } from "../../lib/internal/carry/notes.ts";
import {
	type CarryHold,
	carryUnderWay,
	type HoldTiming,
	holdForCarry,
} from "../../lib/internal/carry/under-way.ts";
import { thisMachine } from "../../lib/internal/machine/machine.ts";
import { questLoadedIn } from "../../lib/internal/quest/sessions/loaded.ts";
import { questWorkspacesRoot } from "../../lib/internal/quest/workspace/workspace-root.ts";
import { treesHeldBy } from "../../lib/internal/work-records.ts";
import { memoryDbPath, openMemoryStore } from "../../lib/memory/index.ts";

/** How long an ended run may take to wind down before the carry gives up. */
const WIND_DOWN_MS = 30_000;

/** How often winding down is looked at. */
const WIND_DOWN_LOOK_MS = 100;

/** What carrying reads of the session. */
export type CarriedContext = Pick<
	ExtensionContext,
	"sessionManager" | "isIdle" | "hasUI" | "ui"
>;

/** Where carrying looks, given in tests. */
export interface CarryingPlaces {
	readonly home?: string;
	readonly windDownMs?: number;
	/** The session's environment, whose `PI_SANDBOX` says its fence. */
	readonly env?: NodeJS.ProcessEnv;
	/** The quest's remembered facts; this machine's memory store's by default. */
	readonly notes?: (quest: string) => Promise<readonly CarriedNote[]>;
	/**
	 * The hold already taken for this carry, as an ordered one takes it
	 * at its order and lets it go itself; else the carry takes its own,
	 * timed by `timing`.
	 */
	readonly hold?: CarryHold;
	readonly timing?: HoldTiming;
}

/**
 * Carries this session's work for the machine `to`, answering the done
 * file it wrote; throws, saying why, when it couldn't carry at all.
 */
export async function carryThisSession(
	ctx: CarriedContext,
	to: string,
	places: CarryingPlaces = {},
): Promise<string> {
	const id = ctx.sessionManager.getSessionId();
	// One past its time still writes the handover this one would.
	const other = carryUnderWay(id, { except: places.hold, evenLapsed: true });
	if (other !== undefined) {
		throw new Error(`a carry to ${other} is already under way.`);
	}
	if (places.hold !== undefined) return await carryOut(ctx, to, places);
	const hold = holdForCarry(id, to, places.timing);
	try {
		return await carryOut(ctx, to, places);
	} finally {
		hold.release();
	}
}

async function carryOut(
	ctx: CarriedContext,
	to: string,
	places: CarryingPlaces,
): Promise<string> {
	await windDown(ctx, places.windDownMs ?? WIND_DOWN_MS);
	const sessions = ctx.sessionManager;
	const id = sessions.getSessionId();
	const quest = await questLoadedIn(id);
	if (quest === undefined) {
		throw new Error(
			"no quest is loaded, and a carry goes in its quest's handover.",
		);
	}
	const file = sessions.getSessionFile();
	const title = sessions.getSessionName();
	const carried = await carryAway({
		exec: spawnExec(),
		into: handoverOf(questWorkspacesRoot(), quest, thisMachine()),
		home: places.home ?? homedir(),
		quest,
		session: {
			id,
			cwd: sessions.getCwd(),
			...(title ? { title } : {}),
			...(file !== undefined && existsSync(file) ? { file } : {}),
		},
		trees: treesHeldBy(id),
		fence: fenceKindOf(places.env ?? process.env),
		notes: await (places.notes ?? questNotes)(quest),
	});
	const stayed = carried.trees.flatMap((one) =>
		one.kind === "refused" ? [`${one.path}: ${one.why}`] : [],
	);
	if (stayed.length > 0 && ctx.hasUI) {
		ctx.ui.notify(
			`Carried to ${to}, but these trees stay here:\n${stayed.join("\n")}`,
			"warning",
		);
	}
	return carried.file;
}

/** The quest's facts in this machine's memory store. */
async function questNotes(quest: string): Promise<CarriedNote[]> {
	const store = await openMemoryStore(await memoryDbPath());
	try {
		return await notesOf(store, quest);
	} finally {
		await store.close();
	}
}

/** Waits until the session is between runs, or throws once it never is. */
async function windDown(ctx: CarriedContext, within: number): Promise<void> {
	const until = Date.now() + within;
	while (!ctx.isIdle()) {
		if (Date.now() >= until) {
			throw new Error(`its run didn't end within ${within / 1000} s.`);
		}
		await new Promise((done) => setTimeout(done, WIND_DOWN_LOOK_MS));
	}
}
