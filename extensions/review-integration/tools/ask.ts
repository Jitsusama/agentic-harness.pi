/**
 * `review_ask`: putting a change to other models.
 *
 * The rounds are separate kinds rather than one `run` with a mode,
 * because a council and a judge differ in what they are told, what
 * they are allowed to conclude, and how their findings are
 * attributed. Reading them back is `review_see findings`, and
 * deciding what to do about them is `review_draft decide`: this tool
 * only produces.
 *
 * Participants read a snapshot pinned to the commit under review,
 * cut through the working layer, so a change that is not checked out
 * here is still reviewed against its own code. When no working layer
 * is loaded, or the provider cannot say which commit is under review,
 * the round still runs against the caller's own tree and says so:
 * losing a council to a missing optional dependency would be worse
 * than a caveat, and reviewing the wrong code silently would be worse
 * than both.
 *
 * This file takes a call to the round it asks for. The councils are in
 * `ask-council.ts`, the rounds that weigh one in `ask-weigh.ts`, the
 * round over a stack in `ask-stack.ts`, what every round shares in
 * `ask-round.ts`, and how a reviewer is run in `ask-reviewer.ts`.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type ChangeRef,
	createRunStore,
	describeRun,
} from "../../../lib/core/review/index.ts";
import { sessionCwd, sessionKeyOf } from "../../../lib/core/session/index.ts";
import { questLoadedIn } from "../../../lib/internal/quest/sessions/loaded.ts";
import {
	endsWithItsPrompts,
	runOrHandOff,
} from "../../../lib/jobs/hand-off.ts";
import { count } from "../../../lib/ui/count.ts";
import { councilStartsPath, liveBus, runDir } from "../engine.ts";
import { answerWatching } from "../progress.ts";
import { askCouncil, retryOne, startRound } from "./ask-council.ts";
import { lineSaid } from "./ask-line.ts";
import { type RoundSeat, reportRoster } from "./ask-roster.ts";
import { type AskParams, releaseIdentity } from "./ask-round.ts";
import { collectOne, stopRound } from "./ask-settle.ts";
import { askStack } from "./ask-stack.ts";
import { askAudit, askCritique, askJudge } from "./ask-weigh.ts";
import { person } from "./heard.ts";
import {
	type Answer,
	boundFor,
	messageOf,
	refuse,
	reviewedChange,
	say,
} from "./shared.ts";

/** Where this call is being asked from. */
async function seatFor(
	ctx: ExtensionContext,
	params: AskParams,
	change?: ChangeRef,
	signal?: AbortSignal,
): Promise<RoundSeat> {
	const quest = await questLoadedIn(ctx.sessionManager.getSessionId());
	return {
		cwd: sessionCwd(ctx),
		said: person.said,
		...(signal === undefined ? {} : { signal }),
		place: {
			...(params.set === undefined ? {} : { set: params.set }),
			...(quest === undefined ? {} : { quest }),
			...(change === undefined ? {} : { project: change.repo.key }),
		},
		...(ctx.model === undefined
			? {}
			: { sessionModel: `${ctx.model.provider}/${ctx.model.id}` }),
	};
}

/**
 * Do what a `review_ask` call asks, once the tool is first called: a
 * round still going after a minute moves to a job.
 */
export async function runAsk(
	pi: ExtensionAPI,
	toolCallId: string,
	params: AskParams,
	callSignal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<Answer> {
	const action = params.action ?? "runs";
	// A round waits for its start for up to two hours, through reloads
	// that leave this call's own bus refusing everything said on it.
	const bus = liveBus(pi.events);
	// A round runs for minutes, deaf to the person and the mesh while
	// it holds the turn, so one still going after a minute moves to a
	// job, as a long command does.
	return await runOrHandOff<unknown>({
		kind: "review",
		label: `${action} on ${params.change ?? "the attached change"}`,
		noun: "background round",
		filePrefix: "pi-review-ask",
		stopping: (jobId) =>
			`To stop it, call the jobs tool's stop with ${jobId} (load it with tool_search), which stops every reviewer and keeps what they wrote. The person can stop it with /jobs.`,
		quiet: "Its board shows how far each reviewer has got.",
		toolCallId,
		session: sessionKeyOf(ctx),
		nested: endsWithItsPrompts(ctx.mode),
		signal: callSignal,
		onUpdate: undefined,
		bus,
		run: (signal) => answerAsk(signal),
	});

	// One watch per call rather than one per round helper, so the
	// board and the signal are the same objects everything sees, and
	// every board this call opens comes down as its answer is handed
	// back, including the answer to a round that threw.
	function answerAsk(signal: AbortSignal): Promise<Answer> {
		return answerWatching(ctx, signal, async (watch) => {
			try {
				// Before the change is bound, because this one is about the
				// roster and not about any change. Binding first made the
				// listing refuse from exactly the position it exists to be
				// reachable from: deciding who to ask, before attaching
				// anything to ask them about.
				if (action === "roster") {
					return await reportRoster(await seatFor(ctx, params));
				}

				const bound = await boundFor(pi, params, sessionCwd(ctx));
				const change = reviewedChange(bound);
				if (change === undefined) {
					return refuse(
						"A list of refs is put to the roster all together with action stack. Every other round takes a hosted change, or a local range as base and head.",
					);
				}

				const seat = await seatFor(ctx, params, change, signal);
				switch (action) {
					case "runs":
						return await reportRuns(change);
					case "collect":
						return await collectOne(change, params);
					case "council":
						return await askCouncil(
							bound,
							change,
							params,
							seat,
							watch("council"),
						);
					case "start":
						return await startRound(bus, bound, change, params, seat);
					case "stop":
						return await stopRound(change, params);
					case "judge":
						return await askJudge(bound, change, params, seat, watch("judge"));
					case "critique":
						return await askCritique(
							bound,
							change,
							params,
							seat,
							watch("critique"),
						);
					case "audit":
						return await askAudit(bound, change, params, seat, watch("audit"));
					case "stack":
						return await askStack(pi, bound, params, seat, watch("stack"));
					case "retry":
						// Watched once it knows whose role it asks again.
						return await retryOne(bound, change, params, seat, watch);
					case "release":
						return releaseIdentity(params);
				}
			} catch (error) {
				return refuse(messageOf(error));
			}
		});
	}
}

/**
 * What has been asked about this change so far, and where any round
 * still waiting for its start stands in the machine's line.
 */
async function reportRuns(change: ChangeRef): Promise<Answer> {
	const runs = await createRunStore(runDir()).list(change);
	const waiting = await lineSaid(councilStartsPath(), change.label);
	if (runs.length === 0 && waiting.length === 0) {
		return say(
			`Nothing has been asked about ${change.label} yet. Run a council to start.`,
			{ runs: [] },
		);
	}
	const lines = runs.map((run) => describeRun(run));
	return say(
		[
			`${count(runs.length, "round")} on ${change.label}:`,
			...lines,
			...waiting,
		].join("\n"),
		{ runs },
	);
}
