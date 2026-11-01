/**
 * Rollover workflow extension: a session whose log has grown large
 * carries on in a fresh log after a compaction, holding only what the
 * model still sees, with the old log named as its parent (see
 * lib/internal/session/rollover.ts for what is kept and why).
 *
 * It happens at the first still moment after a compaction of a log of
 * `ROLLOVER_BYTES` or more: the run has settled, the person has not
 * stopped it and no reload is waiting. `/rollover` does it at once,
 * whatever the log's size. Background jobs run on through it: the job
 * host parks them for the fresh session, which carries the conversation
 * on (see extensions/job-workflow/lifecycle.ts). Only a session somebody sits at rolls over; a
 * subagent or a print run is short. `PI_ROLLOVER=off` turns it off.
 *
 * The switch goes through pi's own `switchSession`, so every extension
 * starts on the fresh log as it would on a resumed one, rebuilding its
 * state from the branch. The model and thinking level the session ran
 * on are carried across and set back once the fresh session starts,
 * since pi's own restore can come up on no model (see
 * lib/internal/session/carried-model.ts). Any session that starts on no
 * model says so in its window, rather than failing its next call out
 * of sight; at startup pi says so itself.
 *
 * A log rolled over before the system messages were folded lost the
 * built-in tools on its next restart; when one starts, they are given
 * back (see `builtInsLostToRollover`).
 */

import { statSync } from "node:fs";
import { dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { formatSize } from "../../lib/internal/quest/footprint.ts";
import { reloadSlot } from "../../lib/internal/reload/slot.ts";
import {
	carryModel,
	hasNoModel,
	NO_PROVIDER,
	takeCarriedModel,
} from "../../lib/internal/session/carried-model.ts";
import {
	builtInsLostToRollover,
	type Carry,
	type Entry,
	ROLLOVER_BYTES,
	ROLLOVER_CARRY,
	ROLLOVER_ENV,
	rollOver,
	writeRolled,
} from "../../lib/internal/session/rollover.ts";

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
	carryModel({
		path,
		provider: ctx.model?.provider ?? NO_PROVIDER,
		modelId: ctx.model?.id ?? "",
		thinkingLevel: pi.getThinkingLevel(),
	});
	const { cancelled } = await ctx.switchSession(path, {
		withSession: async (fresh) => {
			fresh.ui.notify(said, "info");
		},
	});
	return cancelled ? "Not rolled over: the switch was called off." : said;
}

/**
 * Give back the built-in tools a log rolled over by an earlier version
 * of this extension lost on a resume, and say so. Returns their names.
 */
export function restoreLostBuiltIns(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "setActiveTools">,
	ctx: Pick<ExtensionContext, "sessionManager" | "hasUI" | "ui">,
): string[] {
	// Most logs lost nothing, and their branch is all that is read.
	const candidates = builtInsLostToRollover(ctx.sessionManager.getBranch());
	if (candidates.length === 0) return [];
	const active = pi.getActiveTools();
	const registered = new Set(pi.getAllTools().map((tool) => tool.name));
	const lost = candidates.filter(
		(name) => registered.has(name) && !active.includes(name),
	);
	if (lost.length === 0) return [];
	pi.setActiveTools([...active, ...lost]);
	if (ctx.hasUI) {
		ctx.ui.notify(
			`Gave back ${lost.join(", ")}, which this session's rolled-over log had lost.`,
			"info",
		);
	}
	return lost;
}

/**
 * Set back the model and thinking level a rollover carried into this
 * session, and say so loudly when a session that replaced another is
 * left on no model. pi's own start says when it has none, so a
 * startup is left to it. Returns the model it ended on, as
 * provider/id, or nothing.
 */
export async function restoreCarriedModel(
	pi: Pick<ExtensionAPI, "setModel" | "getThinkingLevel" | "setThinkingLevel">,
	ctx: Pick<
		ExtensionContext,
		"sessionManager" | "model" | "modelRegistry" | "hasUI" | "ui"
	>,
	reason: SessionStartEvent["reason"],
): Promise<string | undefined> {
	const carried = takeCarriedModel(ctx.sessionManager.getSessionFile());
	let missing: string | undefined;
	if (carried) {
		const named = `${carried.provider}/${carried.modelId}`;
		const on =
			ctx.model?.provider === carried.provider &&
			ctx.model.id === carried.modelId;
		if (!on) {
			const model = ctx.modelRegistry.find(carried.provider, carried.modelId);
			if (!model || !(await pi.setModel(model))) missing = named;
		}
		if (!missing && pi.getThinkingLevel() !== carried.thinkingLevel) {
			pi.setThinkingLevel(carried.thinkingLevel);
		}
	}
	if (hasNoModel(ctx.model)) {
		if (reason === "startup") return undefined;
		const had = missing
			? ` It ran on ${missing} before rolling over, which can't be found now.`
			: "";
		if (ctx.hasUI) {
			ctx.ui.notify(
				`This session has no model, so it can't answer.${had} Choose one with /model.`,
				"error",
			);
		}
		return undefined;
	}
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
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
	const still = () => reloadSlot().request === undefined;

	pi.on("session_start", async (event, ctx) => {
		due = false;
		restoreLostBuiltIns(pi, ctx);
		await restoreCarriedModel(pi, ctx, event.reason);
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
