/**
 * Away Workflow Extension
 *
 * Makes working while the person is away a mode the harness knows
 * about. While it is on, nothing waits on them: an approval guard that
 * blocks holds its call instead of opening a panel (nothing is sent),
 * `ask` takes the asker's recommendation, and a run that ends without
 * saying `Done:` or `Blocked:` is sent back to work with the goal.
 *
 * The model switches it on with the `away` tool when the person says
 * they are leaving; a typed message that reads like a departure adds a
 * hint to the turn, but the harness never decides on a phrase match.
 * `/away` is a fallback. Only the person ends it: by submitting a
 * message, or by stopping a run with Escape. Their message goes through
 * at once, with a note listing what was held and decided. Nothing held
 * is approved by coming back; a call still wanted is made again and
 * asks in its own panel.
 *
 * The state is `lib/internal/away/`, shared through `globalThis`, so the
 * gates, `ask` and quest-workflow read it without importing this.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	comeBack,
	goAway,
	heldCalls,
	isAway,
	onAwayChange,
	planProgress,
	snapshot,
} from "../../lib/internal/away/state.ts";
import { findJobHost, type Job } from "../../lib/jobs/index.ts";
import { drawInto, firstText } from "../../lib/ui/index.ts";
import {
	afterRun,
	combine,
	freshMemory,
	type RunSummary,
	summarize,
} from "./keep-going.ts";
import { restoreAway, STATUS_KEY, saveAway, statusText } from "./lifecycle.ts";
import {
	awayNow,
	DEPARTURE_HINT,
	readsLikeDeparture,
	returnMessage,
} from "./messages.ts";

/** Custom message types away mode speaks in. */
const RETURN_MESSAGE = "away-return";
const HINT_MESSAGE = "away-hint";
const STOPPED_MESSAGE = "away-stopped";

const NOTHING_RUN: RunSummary = { lastText: "", toolCalls: 0, aborted: false };

/**
 * Whether pi says the run was aborted. Its settled event carries the
 * flag from pi 1.1; older versions do not, which is why the run's own
 * last message is read as well.
 */
function settledAborted(event: unknown): boolean {
	return (
		typeof event === "object" &&
		event !== null &&
		"aborted" in event &&
		event.aborted === true
	);
}

export default function awayWorkflow(pi: ExtensionAPI) {
	let latest: ExtensionContext | undefined;
	let restoring = false;
	let run = NOTHING_RUN;
	let pendingNudge: Job | undefined;
	const memory = freshMemory();

	const showStatus = (ctx: ExtensionContext | undefined) => {
		if (!ctx?.hasUI) return;
		const text = statusText(snapshot());
		ctx.ui.setStatus(
			STATUS_KEY,
			text ? ctx.ui.theme.fg("warning", text) : undefined,
		);
	};

	const disposeListener = onAwayChange((now) => {
		if (restoring) return;
		saveAway(pi, now);
		showStatus(latest);
	});

	/**
	 * Say something to the model with the person's next message, or
	 * alongside the run under way when there is one, so it is read now
	 * rather than a turn late.
	 */
	const sayWithTurn = (
		ctx: ExtensionContext,
		customType: string,
		content: string,
	) => {
		pi.sendMessage(
			{ customType, content, display: true },
			{ deliverAs: ctx.isIdle() ? "nextTurn" : "steer" },
		);
	};

	/** The person is here: end the absence and say what waited. */
	const endAway = (ctx: ExtensionContext) => {
		// A nudge not yet said would tell the model they are still away.
		pendingNudge?.withdraw();
		pendingNudge = undefined;
		const back = comeBack();
		if (!back) return;
		const text = returnMessage(back);
		if (text) sayWithTurn(ctx, RETURN_MESSAGE, text);
	};

	/** A run settled while away: send it back to work, or let it rest. */
	const keepGoing = (finished: RunSummary) => {
		const since = snapshot().since;
		if (since === undefined) return;
		const progress = planProgress();
		const verdict = afterRun(
			finished,
			{
				since,
				...(snapshot().goal ? { goal: snapshot().goal } : {}),
				held: heldCalls().length,
				...(progress ? { progress } : {}),
			},
			memory,
		);
		if (verdict.kind === "stop") {
			pi.sendMessage(
				{ customType: STOPPED_MESSAGE, content: verdict.note, display: true },
				{ triggerTurn: false },
			);
			return;
		}
		if (verdict.kind !== "nudge") return;
		const host = findJobHost(pi.events);
		if (!host) {
			latest?.ui.notify(
				"Away mode cannot send the run back to work: job-workflow is not loaded.",
				"warning",
			);
			return;
		}
		const job = host.start({
			kind: "away",
			label: "keep working while the user is away",
		});
		pendingNudge = job;
		job.onDelivered(() => {
			if (pendingNudge === job) pendingNudge = undefined;
		});
		job.finish({ summary: verdict.text });
	};

	pi.on("session_start", async (_event, ctx) => {
		latest = ctx;
		restoring = true;
		try {
			restoreAway(ctx);
		} finally {
			restoring = false;
		}
		showStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		disposeListener();
		pendingNudge = undefined;
	});

	// A message the person submits is the surest sign they are back.
	// Commands never reach here: pi runs them before input handlers,
	// which is why `/away` handles its own ending.
	pi.on("input", async (event, ctx) => {
		latest = ctx;
		if (event.source !== "interactive") return;
		if (isAway()) endAway(ctx);
		if (readsLikeDeparture(event.text)) {
			sayWithTurn(ctx, HINT_MESSAGE, DEPARTURE_HINT);
		}
	});

	// A run can end more than once before it settles (a retry, a queued
	// follow-up), so what it did is gathered until it does.
	pi.on("agent_end", async (event) => {
		run = combine(run, summarize(event.messages));
	});

	pi.on("agent_settled", async (event, ctx) => {
		latest = ctx;
		const finished = run;
		run = NOTHING_RUN;
		if (!isAway()) return;
		if (settledAborted(event) || finished.aborted) {
			// Escape is the person, here, saying stop.
			endAway(ctx);
			ctx.ui.notify("Away mode ended: you stopped the run.", "info");
			return;
		}
		keepGoing(finished);
	});

	pi.registerCommand("away", {
		description:
			"Away mode: hold blocking approvals, take ask's recommendations and keep the run going until it says Done or Blocked. Run again, or type anything, to come back.",
		handler: async (args, ctx) => {
			latest = ctx;
			if (isAway()) {
				endAway(ctx);
				ctx.ui.notify("Away mode ended. Welcome back.", "info");
				return;
			}
			goAway(args.trim() || undefined);
			ctx.ui.notify(
				"Away mode on: approvals are held and the run keeps going.",
				"info",
			);
		},
	});

	pi.registerTool({
		name: "away",
		label: "Away",
		description:
			"Switch on away mode when the user says they are leaving or asks you to work unattended. Until they are back, blocking approvals are held instead of waiting on them (nothing is sent), ask takes your recommendation, and a run that does not end with a `Done:` or `Blocked:` line is sent back to work. Only the user ends it, by typing.",
		promptSnippet:
			"Switch on away mode when the user says they are leaving now or wants unattended work.",
		promptGuidelines: [
			"Call away when the user says, of themselves and now, that they are leaving, going to sleep or want you to work unattended; pass their goal in their words. Not when a pasted or quoted text mentions being away.",
			"While away, a held call is not a blocker: carry on with other work, and do not look for another way round the gate.",
			"While away, end a run only with a last line starting `Done:` (goal met) or `Blocked:` (everything left needs the user).",
		],
		parameters: Type.Object({
			goal: Type.Optional(
				Type.String({
					description:
						"What the user asked to have done while they are away, in their words, e.g. 'work through the remaining subquests'.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latest = ctx;
			const started = goAway(params.goal);
			return {
				content: [
					{
						type: "text",
						text: awayNow(params.goal ?? snapshot().goal, !started),
					},
				],
				details: { started },
			};
		},
		renderCall(args, theme, context) {
			const goal = typeof args.goal === "string" ? ` ${args.goal}` : "";
			return drawInto(
				context?.lastComponent,
				theme.fg("toolTitle", theme.bold("away")) + theme.fg("muted", goal),
			);
		},
		renderResult(result, _options, theme, context) {
			return drawInto(
				context?.lastComponent,
				theme.fg("warning", firstText(result).split("\n")[0] ?? ""),
			);
		},
	});
}
