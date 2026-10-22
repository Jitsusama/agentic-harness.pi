/**
 * Rollover workflow extension: a session whose log has grown large
 * carries on in a fresh log after a compaction, holding only what the
 * model still sees, with the old log named as its parent (see
 * lib/internal/session/rollover.ts for what is kept and why).
 *
 * It happens at the first still moment after a compaction of a log of
 * `ROLLOVER_BYTES` or more: the run has settled, the person has not
 * stopped it, no background job is running (a session switch ends
 * them) and no reload is waiting. `/rollover` does it at once, whatever
 * the log's size. Only a session somebody sits at rolls over; a
 * subagent or a print run is short. `PI_ROLLOVER=off` turns it off.
 *
 * The switch goes through pi's own `switchSession`, so every extension
 * starts on the fresh log as it would on a resumed one, rebuilding its
 * state from the branch.
 */

import { statSync } from "node:fs";
import { dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { formatSize } from "../../lib/internal/quest/footprint.ts";
import { reloadSlot } from "../../lib/internal/reload/slot.ts";
import {
	type Carry,
	type Entry,
	ROLLOVER_BYTES,
	ROLLOVER_CARRY,
	ROLLOVER_ENV,
	rollOver,
	writeRolled,
} from "../../lib/internal/session/rollover.ts";
import { findJobHost } from "../../lib/jobs/index.ts";

/** The command that rolls the session over. */
export const COMMAND = "rollover";

/** Whether this process is a subagent rather than a session. */
function isSubagent(env: NodeJS.ProcessEnv): boolean {
	return env.SUBAGENT_SUPERVISOR === "1" || Boolean(env.SUBAGENT_RUN_ID);
}

/** The size of a log, or 0 when there is none to measure. */
function sizeOf(path: string | undefined): number {
	if (!path) return 0;
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** Whether a settled run was stopped by the person. */
function settledAborted(event: unknown): boolean {
	return (
		typeof event === "object" &&
		event !== null &&
		"aborted" in event &&
		event.aborted === true
	);
}

/** Whether this session rolls over by itself. */
export function rollsOver(
	ctx: Pick<ExtensionContext, "hasUI">,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return ctx.hasUI && !isSubagent(env) && env[ROLLOVER_ENV]?.trim() !== "off";
}

/**
 * Roll the session over now. Returns what to tell the person, or why
 * it did not.
 */
export async function rollOverNow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<string> {
	await ctx.waitForIdle();
	const sessions = ctx.sessionManager;
	const parent = sessions.getSessionFile();
	if (!parent)
		return "This session keeps no log, so there is none to roll over.";
	const jobs = findJobHost(pi.events)?.pending?.() ?? 0;
	if (jobs > 0) {
		return "Not rolled over: background jobs are running, and switching logs would end them.";
	}
	const carry: Carry = { carried: {} };
	pi.events.emit(ROLLOVER_CARRY, carry);
	const rolled = rollOver(sessions.getBranch() as unknown as Entry[], {
		parentSession: parent,
		cwd: sessions.getCwd(),
		version: sessions.getHeader()?.version,
		carried: carry.carried,
	});
	if (!rolled) {
		return "Nothing to roll over: this session has no compaction to start a fresh log from.";
	}
	const before = sizeOf(parent);
	const path = writeRolled(dirname(parent), rolled);
	const after = sizeOf(path);
	const size = (bytes: number) => formatSize({ bytes, complete: true });
	const said = `Rolled this session over into a fresh log (${size(before)} to ${size(after)}); the earlier log is its parent, and session_recall still reads it.`;
	const { cancelled } = await ctx.switchSession(path, {
		withSession: async (fresh) => {
			fresh.ui.notify(said, "info");
		},
	});
	return cancelled ? "Not rolled over: the switch was called off." : said;
}

export default function rolloverWorkflow(pi: ExtensionAPI) {
	// A compaction has made the log's history dead weight; the next still
	// moment hands the rollover to the command, which can switch logs.
	let due = false;

	const dispatch = () => {
		due = false;
		pi.sendUserMessage(`/${COMMAND}`, { expandPromptTemplates: true });
	};

	/** Whether nothing would be lost by switching logs now. */
	const still = () =>
		reloadSlot().request === undefined &&
		(findJobHost(pi.events)?.pending?.() ?? 0) === 0;

	pi.on("session_start", async () => {
		due = false;
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (!rollsOver(ctx)) return;
		if (sizeOf(ctx.sessionManager.getSessionFile()) < ROLLOVER_BYTES) return;
		due = true;
		// A compaction asked for between runs has no settle to wait for.
		let idle = false;
		try {
			idle = ctx.isIdle();
		} catch {
			return;
		}
		if (idle && still()) dispatch();
	});

	pi.on("agent_settled", async (event) => {
		if (!due || settledAborted(event) || !still()) return;
		dispatch();
	});

	pi.registerCommand(COMMAND, {
		description:
			"Carry on in a fresh log holding only what the model still sees, with this one as its parent.",
		handler: async (_args, ctx) => {
			const said = await rollOverNow(pi, ctx);
			// A successful switch said it in the fresh session already.
			if (!said.startsWith("Rolled")) ctx.ui.notify(said, "info");
		},
	});
}
