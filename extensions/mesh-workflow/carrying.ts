/**
 * Carrying this session's work to another machine, when the person
 * steers it to (pausing.ts's Carry): every tree the work broker holds
 * for it, and its own file, into its quest's handover, with the done file
 * mycelium waits for written last (lib/internal/carry/carry-away.ts).
 *
 * Its run is ended first and waited out, so the file carried holds the
 * whole session. A tree that can't be carried is named on screen and the
 * rest still go; a session with no quest loaded has no handover to carry
 * into, so it refuses, and stays open.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnExec } from "../../lib/core/exec/index.ts";
import { carryAway } from "../../lib/internal/carry/carry-away.ts";
import { handoverOf } from "../../lib/internal/carry/handover.ts";
import { thisMachine } from "../../lib/internal/machine.ts";
import { questLoadedIn } from "../../lib/internal/quest/loaded.ts";
import { questWorkspacesRoot } from "../../lib/internal/quest/workspace-root.ts";
import { treesHeldBy } from "../../lib/internal/work-records.ts";

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
