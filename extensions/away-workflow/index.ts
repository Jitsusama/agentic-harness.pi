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
 *
 * The absence is the machine's, not the window's: leaving in one
 * interactive session puts every interactive session on the machine
 * away, and typing or pressing Escape in any of them brings them all
 * back (`lib/internal/away/machine.ts`). Sessions without a UI, such as
 * subagents and print-mode runs, neither follow nor publish it, since
 * nobody is at them to leave or come back.
 *
 * What needs the absent person reaches them through a desktop
 * notification (`reach.ts`): the first call held in an absence, and a
 * run that rests `Blocked:`. The session carries on with the rest.
 *
 * A person who never said they were leaving is covered too
 * (`carry-on.ts`): when a run ends with a plan in build still open and
 * nobody answers for a quiet stretch, the session takes the next item,
 * and a question it asked reaches the desktop. `PI_CARRY_ON=off` turns
 * that off.
 */

import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	agree,
	type MachineWord,
	publishMachineWord,
	readMachineWord,
	watchMachineWord,
} from "../../lib/internal/away/machine.ts";
import {
	comeBack,
	goAway,
	heldCalls,
	isAway,
	onAwayChange,
	planProgress,
	snapshot,
} from "../../lib/internal/away/state.ts";
import { type Notice, notify } from "../../lib/internal/notify.ts";
import { findJobHost, type Job } from "../../lib/jobs/index.ts";
import {
	asText,
	drawInto,
	firstText,
	renderToolCall,
} from "../../lib/ui/index.ts";
import {
	askedNotice,
	carryOnText,
	endsAsking,
	freshCarryOn,
	QUIET_MS,
	shouldWait,
} from "./carry-on.ts";
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
import { blockedNotice, freshReach, heldNotice, stopNotice } from "./reach.ts";

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
	let stopWatching: () => void = () => {};
	const memory = freshMemory();
	const reached = freshReach();
	const carrying = freshCarryOn();
	let quiet: ReturnType<typeof setTimeout> | undefined;
	let pendingCarry: Job | undefined;

	/** Stop waiting out a quiet stretch: something answered it. */
	const stopWaiting = () => {
		if (quiet) clearTimeout(quiet);
		quiet = undefined;
	};

	/**
	 * Put a notice in front of the person, from an interactive session
	 * only: a subagent's needs reach them through the session that ran it.
	 * Never waited on, so a slow desktop holds nothing up.
	 */
	const reach = (notice: Notice | undefined) => {
		if (!notice || !latest?.hasUI) return;
		void notify(notice);
	};

	/** The name a notice gives this session: its document, else its folder. */
	const where = (): string =>
		planProgress()?.document ?? (basename(latest?.cwd ?? "") || "pi");

	const showStatus = (ctx: ExtensionContext | undefined) => {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, statusText(snapshot(), ctx.ui.theme));
	};

	const disposeListener = onAwayChange((now) => {
		if (restoring) return;
		saveAway(pi, now);
		showStatus(latest);
		if (now.since !== undefined) {
			// Keep-going speaks for an absence; one voice is enough.
			stopWaiting();
			reach(heldNotice(where(), now.since, now.held.length, reached));
		}
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

	/**
	 * The person is here: end the absence and say what waited.
	 * `elsewhere` when they came back in another window.
	 */
	const endAway = (ctx: ExtensionContext, elsewhere = false) => {
		// A nudge not yet said would tell the model they are still away.
		pendingNudge?.withdraw();
		pendingNudge = undefined;
		const back = comeBack();
		if (!back) return;
		const text = returnMessage(back, elsewhere);
		if (text) sayWithTurn(ctx, RETURN_MESSAGE, text);
	};

	/** Tell every session on the machine the person is away. */
	const publishAway = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const now = snapshot();
		if (now.since === undefined) return;
		publishMachineWord({
			since: now.since,
			...(now.goal !== undefined ? { goal: now.goal } : {}),
		});
	};

	/**
	 * Tell every session on the machine the person is here, unless the
	 * machine already says so: that word needs no rewrite, and every
	 * rewrite wakes every watching session. No word at all is written
	 * over too, since sessions can be away from before the word was
	 * shared, and they come back only on hearing it.
	 */
	const publishHere = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const word = readMachineWord();
		if (!word || word.away) publishMachineWord(undefined);
	};

	/** Do what this session must to agree with the machine's word. */
	const follow = (ctx: ExtensionContext, word: MachineWord | undefined) => {
		const agreement = agree(word, snapshot());
		if (agreement.kind === "go-away") {
			goAway(agreement.goal, new Date(agreement.since));
		} else if (agreement.kind === "come-back") {
			endAway(ctx, true);
			ctx.ui.notify("Away mode ended: you are back at the machine.", "info");
		}
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
		if (verdict.kind === "rest" && verdict.why === "blocked") {
			reach(blockedNotice(where(), since, finished.lastText, reached));
			return;
		}
		if (verdict.kind === "stop") {
			reach(stopNotice(where(), since, verdict.note, reached));
			pi.sendMessage(
				{ customType: STOPPED_MESSAGE, content: verdict.note, display: true },
				{ triggerTurn: false },
			);
			return;
		}
		if (verdict.kind !== "nudge") return;
		const job = startJob("away", "keep working while the user is away");
		if (!job) return;
		pendingNudge = job;
		job.onDelivered(() => {
			if (pendingNudge === job) pendingNudge = undefined;
		});
		job.finish({ summary: verdict.text });
	};

	/**
	 * A job whose summary will start the next turn once it is finished,
	 * or nothing, said, when no job host is loaded.
	 */
	const startJob = (kind: string, label: string): Job | undefined => {
		const host = findJobHost(pi.events);
		if (!host) {
			latest?.ui.notify(
				"Away mode cannot send the run back to work: job-workflow is not loaded.",
				"warning",
			);
			return undefined;
		}
		return host.start({ kind, label });
	};

	/**
	 * The quiet stretch after a run ran out with nobody answering: carry
	 * on with the plan, reaching the person if the run asked them
	 * something. Rechecked now, since the stretch is long.
	 */
	const carryOn = (finished: RunSummary) => {
		quiet = undefined;
		if (isAway() || !latest) return;
		try {
			if (!latest.isIdle()) return;
		} catch {
			// A context a reload replaced; its successor waits for itself.
			return;
		}
		const progress = planProgress();
		if (!progress || progress.total - progress.done <= 0) return;
		const asked = endsAsking(finished.lastText);
		if (asked) reach(askedNotice(where(), finished.lastText, carrying));
		const job = startJob(
			"carry-on",
			"carry on with the plan while nobody answers",
		);
		if (!job) return;
		carrying.carried += 1;
		pendingCarry = job;
		job.onDelivered(() => {
			if (pendingCarry === job) pendingCarry = undefined;
		});
		job.finish({ summary: carryOnText(progress, asked) });
	};

	/** A run settled with the person here: wait for them, then carry on. */
	const waitForAnswer = (ctx: ExtensionContext, finished: RunSummary) => {
		stopWaiting();
		if (!ctx.hasUI || process.env.PI_CARRY_ON === "off") return;
		if (!shouldWait(finished, planProgress(), carrying)) return;
		quiet = setTimeout(() => carryOn(finished), QUIET_MS);
		quiet.unref?.();
	};

	pi.on("session_start", async (_event, ctx) => {
		latest = ctx;
		restoring = true;
		try {
			restoreAway(ctx);
		} finally {
			restoring = false;
		}
		if (ctx.hasUI) {
			follow(ctx, readMachineWord());
			stopWatching();
			stopWatching = watchMachineWord((word) => {
				if (!latest) return;
				try {
					follow(latest, word);
				} catch {
					// A context a reload replaced throws; the live copy's own
					// watch follows the same word.
				}
			});
		}
		showStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopWaiting();
		stopWatching();
		stopWatching = () => {};
		disposeListener();
		pendingNudge = undefined;
	});

	// A message the person submits is the surest sign they are back.
	// Commands never reach here: pi runs them before input handlers,
	// which is why `/away` handles its own ending.
	pi.on("input", async (event, ctx) => {
		latest = ctx;
		if (event.source !== "interactive") return;
		// The person answered: nothing carries on in their place.
		stopWaiting();
		pendingCarry?.withdraw();
		pendingCarry = undefined;
		Object.assign(carrying, freshCarryOn());
		if (isAway()) endAway(ctx);
		publishHere(ctx);
		if (readsLikeDeparture(event.text)) {
			sayWithTurn(ctx, HINT_MESSAGE, DEPARTURE_HINT);
		}
	});

	// A run can end more than once before it settles (a retry, a queued
	// follow-up), so what it did is gathered until it does.
	// Any run starting, the person's or one a message woke, answers the
	// quiet stretch; its own settling decides whether to wait again.
	pi.on("agent_start", async () => {
		stopWaiting();
	});

	pi.on("agent_end", async (event) => {
		run = combine(run, summarize(event.messages));
	});

	pi.on("agent_settled", async (event, ctx) => {
		latest = ctx;
		const finished = run;
		run = NOTHING_RUN;
		if (!isAway()) {
			if (!settledAborted(event)) waitForAnswer(ctx, finished);
			return;
		}
		if (settledAborted(event) || finished.aborted) {
			// Escape is the person, here, saying stop.
			endAway(ctx);
			publishHere(ctx);
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
				publishHere(ctx);
				ctx.ui.notify("Away mode ended. Welcome back.", "info");
				return;
			}
			goAway(args.trim() || undefined);
			publishAway(ctx);
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
			"Switch on away mode when the user says they are leaving or asks you to work unattended. Until they are back, blocking approvals are held instead of waiting on them (nothing is sent), ask takes your recommendation, and a run that does not end with a `Done:` or `Blocked:` line is sent back to work. It covers every interactive session on the machine, so call it once; only the user ends it, by typing in any of them.",
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
			publishAway(ctx);
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
			const goal = typeof args.goal === "string" ? args.goal : undefined;
			return renderToolCall(
				{ tool: "away", subject: goal },
				theme,
				asText(context?.lastComponent),
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
