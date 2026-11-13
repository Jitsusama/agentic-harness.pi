/**
 * The `review_ask` tool as pi sees it: its schema, its words and how
 * its call and answer read, with what it must hear from the start (a
 * round's watch a move carried in, and what the person types). What a
 * call does is in `ask.ts`, loaded on the tool's first call, so a
 * session that never asks for a round never loads it.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { loadOnce } from "../../../lib/internal/single-flight.ts";
import { takesUpCarried } from "../../../lib/jobs/take-up.ts";
import { THINKING_LEVELS } from "../../../lib/thinking/index.ts";
import { ROUND_WORK, type RoundReading, takeUpRound } from "../round-job.ts";
import type { AskParams } from "./ask.ts";
import { person } from "./heard.ts";
import type { Answer } from "./shared.ts";
import { renderAnswer, renderInvocation } from "./view.ts";

const roundReadingModule = loadOnce(() => import("../round-reading.ts"));
/** review_ask's work, loaded once, for the tool. */
export const askModule = loadOnce(() => import("./ask.ts"));
/** Settling rounds nothing waits on, without the rest of review_ask. */
export const settleModule = loadOnce(() => import("./ask-settle.ts"));

/** What `review_ask` takes. */
const ASK_PARAMETERS = Type.Object({
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("council"),
				Type.Literal("judge"),
				Type.Literal("critique"),
				Type.Literal("audit"),
				Type.Literal("stack"),
				Type.Literal("start"),
				Type.Literal("stop"),
				Type.Literal("runs"),
				Type.Literal("roster"),
				Type.Literal("collect"),
				Type.Literal("retry"),
				Type.Literal("release"),
			],
			{
				description:
					"What to do. council: ask the whole roster and wait; start: the same in the background, finished with collect; stop: end a started round, keeping what was written. judge: consolidate the latest council; critique: the roster pushes back on the judge. audit: judge each unresolved inbound thread. stack: the whole stack at once. runs (the default): the rounds so far. collect: finish a round from what its reviewers left on disk. retry: ask one participant again. release: free an id to mean another model.",
			},
		),
	),
	change: Type.Optional(
		Type.String({
			description:
				"Reference to a hosted change: URL, short form or number. Omit to use the attached change.",
		}),
	),
	base: Type.Optional(
		Type.String({
			description:
				"Base ref, with head, to ask about a local range nobody has proposed. Its rounds and findings are held under base..head, so name it the same way each time.",
		}),
	),
	head: Type.Optional(
		Type.String({ description: "Head ref, with base, for a local range." }),
	),
	repo: Type.Optional(
		Type.String({
			description:
				"Checkout path: the repo for a local review, and for a hosted change a checkout of its repo to cut the round's snapshot from, when the session is not sitting in one.",
		}),
	),
	intent: Type.Optional(
		Type.String({
			description:
				"Extra direction for this round only, e.g. 'look hardest at the error paths'. Not persisted: the standing lens belongs in a participant's persona.",
		}),
	),
	participant: Type.Optional(
		Type.String({
			description: "Which participant to ask again. Required for retry.",
		}),
	),
	run: Type.Optional(
		Type.String({
			description:
				"Which round, by id: for judge, the council to consolidate; for critique, the judge to push back on; for retry, the round to retry into. Defaults to the latest council, or for critique the latest judge.",
		}),
	),
	set: Type.Optional(
		Type.String({
			description:
				"A named roster from review.ask.sets to ask this round, or 'built-in' for the package's own. Only when the person asked for one: otherwise the quest's, the project's or the configured roster is chosen.",
		}),
	),
	// Last, and deliberately after every other parameter: the gate
	// that checks the actions offered against the actions handled
	// reads the file from the action union to the next parameter, so
	// a union of literals in between reads as six more actions.
	who: Type.Optional(
		Type.Record(
			Type.String(),
			Type.Object({
				model: Type.Optional(
					Type.String({
						description:
							"The model, written with a slash, e.g. anthropic/claude-opus-5.",
					}),
				),
				thinkingLevel: Type.Optional(
					Type.Union(
						// The shared list, so this schema and the fan-out
						// tool's cannot drift apart about what pi takes.
						THINKING_LEVELS.map((level) => Type.Literal(level)),
						{ description: "How hard this one thinks." },
					),
				),
				tools: Type.Optional(
					Type.Array(Type.String(), {
						description: "The tool palette this one is given.",
					}),
				),
				persona: Type.Optional(
					Type.String({
						description:
							"The lens to read through, by id; action roster lists them.",
					}),
				),
				backstopMs: Type.Optional(
					Type.Number({
						description:
							"Wall clock for this one, in milliseconds, so a slow reviewer gets longer without the rest.",
					}),
				),
				idleMs: Type.Optional(
					Type.Number({
						description:
							"How long this one may be silent before it counts as wedged, in milliseconds.",
					}),
				),
				answerMs: Type.Optional(
					Type.Number({
						description:
							"How much of its wall is kept back to ask it for what it has, in milliseconds; zero runs it to the wall.",
					}),
				),
			}),
			{
				description:
					"Settings for this round only, by participant id, overriding the roster; action roster shows who it has. Not accepted on a retry.",
			},
		),
	),
});

/**
 * How a round's watch a move carried in reads its round, loading how
 * only once it is taken up, since nearly every session never takes
 * one up.
 */
function readingLater(
	runId: string,
	participants: readonly string[],
): RoundReading {
	const reading = roundReadingModule().then((loaded) =>
		loaded.carriedRoundReading(runId, participants),
	);
	return {
		isRunning: async () => (await reading).isRunning(),
		stop: async () => (await reading).stop(),
	};
}

/** Register the `review_ask` tool. */
export function registerAskTool(pi: ExtensionAPI): void {
	takesUpCarried(pi.events, ROUND_WORK, (work) =>
		takeUpRound(work, readingLater),
	);
	pi.on("input", (event) => {
		if (event.source === "interactive") person.heard(event.text);
	});
	pi.registerTool({
		name: "review_ask",
		// Called in 16 of 70 sessions from 18 October, and the review-guide
		// skill names it, so it loads when that is read.
		exposure: "deferred",
		label: "Review Ask",
		description:
			"Put a change to other models and keep what they say: a council of reviewers reading it independently, a judge consolidating what they found, the rounds already run, and a retry of one participant whose run failed. Produces findings; read them with review_see findings and decide them with review_draft decide.",
		promptSnippet:
			"Ask other models about a change: a council, a judge over it, the rounds so far, or a retry of one participant.",
		promptGuidelines: [
			"Run a council, which shows its progress and, still running after a minute, moves to the background with its result arriving later as a message of its own; use start only when the person asked for a round in the background, and say that it is running there.",
			"The roster is chosen, first match winning: the set this round names, the set the loaded quest names (review.ask.quests), the set the project names (review.ask.projects), the review.ask roster, then a built-in roster of four reviewers and a judge. Name a set only when the person asked for one; the answer says which layer chose. A participant with no model runs on the session's model, at high thinking unless it says otherwise.",
			"When a judge is done, check each of its findings against the source yourself before deciding it, then group what holds up by root cause and fix causes rather than symptoms.",
			"A council is the discovery pass and a judge consolidates it, so run a council first; a judge with no council to read is refused rather than asked to invent one.",
			"An id that has raised findings is held to the model, thinking level, tools and persona it meant. Reconfiguring one is refused, and the refusal names both ways out: another id, or release this one and accept that its findings no longer identify who raised them.",
			"A round reads a snapshot pinned to the commit under review. When none can be cut it reads the checkout only if that checkout is at the commit, and otherwise refuses, naming what to fetch or which checkout to pass as repo: a round against the wrong commit or the wrong repository returns findings that read plausibly and are about other code. Only when the provider reports no commit does the answer carry a caveat naming what was read instead: pass that on.",
			"Reading findings is review_see findings and deciding them is review_draft decide. This tool only produces them.",
			"A round runs on one model and gets its spread from personas, never from other models. A model in who other than the one that participant runs on without it is refused, unless the person asked for that model by name.",
		],
		parameters: ASK_PARAMETERS,

		renderCall(
			args: unknown,
			theme: Theme,
			context?: { lastComponent?: unknown },
		): Text {
			const params = args as AskParams;
			return renderInvocation(
				theme,
				"review_ask",
				params.action ?? "runs",
				params.participant ?? params.change,
				context?.lastComponent,
			);
		},

		renderResult(
			result: Answer,
			options: { expanded?: boolean },
			theme: Theme,
			context?: { lastComponent?: unknown },
		): Text {
			return renderAnswer(result, theme, options, context?.lastComponent);
		},

		// Pi passes (toolCallId, params, signal, onUpdate, ctx). Reading the
		// first as the payload was a real bug: the id is a string, so every
		// field came back undefined and no council could ever run, because
		// every action arrived as `runs`. The signal and the context were lost
		// the same way, and three comments in this extension claimed pi
		// provided neither.
		async execute(
			toolCallId: string,
			args: unknown,
			callSignal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<Answer> {
			const { runAsk } = await askModule();
			return runAsk(pi, toolCallId, args as AskParams, callSignal, ctx);
		},
	});
}
