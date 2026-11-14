/**
 * Ask Workflow Extension
 *
 * Single question: options list with cursor navigation.
 * Multiple questions: tabbed prompt with per-question options.
 * Always includes a free-form "Type something" option when
 * allowOther is enabled.
 *
 * Composes on prompt() for the UI. Single questions use
 * SinglePromptConfig with options. Multiple questions use
 * TabbedPromptConfig with items.
 *
 * A question can name the option the asker recommends. The person sees
 * it marked; while they are away (see away-workflow) nothing is asked
 * at all: the recommendation is taken, or the asker is told to decide
 * from the evidence, and the decision waits for the person's return.
 *
 * A question never holds its turn for long: left unanswered five
 * minutes, or asked while the screen is locked or the person is away
 * from it, it parks on their look list and the session carries on
 * (see parking.ts).
 */

import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { decide, isAway } from "../../lib/internal/away/state.ts";
import { runtimeDir, stateDir } from "../../lib/internal/paths.ts";
import type { WantAsk } from "../../lib/internal/session/wants.ts";
import { renderMarkdown } from "../../lib/ui/content-renderer.ts";
import { count } from "../../lib/ui/count.ts";
import { OUTCOME_GLYPH } from "../../lib/ui/outcome-glyphs.ts";
import { promptSingle, promptTabbed } from "../../lib/ui/panel.ts";
import { asText, drawInto, renderToolCall } from "../../lib/ui/tool-call.ts";
import { firstText } from "../../lib/ui/tool-result.ts";
import type {
	ListChoice,
	PromptCloser,
	PromptItem,
} from "../../lib/ui/types.ts";
import {
	ABSENCE_EVERY_MS,
	absence,
	PARK_AFTER_MS,
	type ParkReason,
	parkedText,
	parkQuestions,
	pointerOf,
	watchToPark,
} from "./parking.ts";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
	recommended?: string;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface AskResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
	/** Why it parked on the look list unanswered, when it did. */
	parked?: ParkReason;
}

/** What a parked question's record and result say, past its mark. */
const PARKED_SAID = "parked on the look list, unanswered";

/** Park `questions` on the person's look list, and say so to the asker. */
function parked(
	questions: Question[],
	session: string,
	reason: ParkReason,
): { content: { type: "text"; text: string }[]; details: AskResult } {
	const pointer = pointerOf(session, {
		presences: join(stateDir("mesh-workflow"), "presence"),
		sessions: join(stateDir("quest-workflow"), "sessions"),
	});
	const kept = parkQuestions(stateDir("looks"), pointer, questions, reason);
	return {
		content: [{ type: "text", text: parkedText(reason, kept) }],
		details: { questions, answers: [], cancelled: false, parked: reason },
	};
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(
		Type.String({ description: "Optional description shown below label" }),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description:
				"Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, {
		description: "Available options to choose from",
	}),
	allowOther: Type.Optional(
		Type.Boolean({
			description: "Allow 'Type something' option (default: true)",
		}),
	),
	recommended: Type.Optional(
		Type.String({
			description:
				"The value of the option you recommend, with the reason in the prompt. While the user is away this is the answer taken without asking.",
		}),
	),
});

const AskParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Questions to ask the user",
	}),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: AskResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

/**
 * Answer without asking, because the person is away: each question takes
 * its recommendation, or is handed back to the asker to decide. Every
 * answer is kept for the person to read on their return.
 */
export function answerWhileAway(questions: Question[]): string {
	const lines = ["The user is away, so nothing was asked."];
	for (const q of questions) {
		const at = q.options.findIndex((o) => o.value === q.recommended);
		const option = q.options[at];
		if (option) {
			decide({
				question: q.prompt,
				answer: option.label,
				by: "recommendation",
			});
			lines.push(
				`${q.label}: took your recommendation: ${at + 1}. ${option.label}`,
			);
		} else {
			decide({
				question: q.prompt,
				answer: "left to the agent",
				by: "model",
			});
			lines.push(
				`${q.label}: no recommendation, so decide from the evidence, say what you chose and why, and carry on.`,
			);
		}
	}
	lines.push("They will see these decisions when they are back.");
	return lines.join("\n");
}

/**
 * The question's choices as its want says them, so the launcher can show
 * them and answer it where the person is.
 */
function wantAsk(q: Question): WantAsk {
	return {
		choices: q.options.map((o) => ({
			value: o.value,
			label: o.label,
			...(o.description === undefined ? {} : { description: o.description }),
		})),
		...(q.recommended === undefined ? {} : { recommended: q.recommended }),
		allowOther: q.allowOther,
	};
}

/** Build options for a question, including the "Type something" option. */
function buildOptions(q: Question): ListChoice[] {
	const opts: ListChoice[] = q.options.map((o) => ({
		label: o.value === q.recommended ? `${o.label} (recommended)` : o.label,
		value: o.value,
		description: o.description,
	}));

	if (q.allowOther) {
		opts.push({
			label: "Type something...",
			value: "__other__",
			opensEditor: true,
		});
	}

	return opts;
}

/** What picking `value`, or writing `editorText`, answers of `q`. */
function answerOf(
	q: Question,
	value: string,
	editorText: string | undefined,
): Answer | undefined {
	if (value === "__other__" && editorText) {
		return { id: q.id, value: editorText, label: editorText, wasCustom: true };
	}
	const at = q.options.findIndex((o) => o.value === value);
	const opt = q.options[at];
	if (!opt) return undefined;
	return {
		id: q.id,
		value: opt.value,
		label: opt.label,
		wasCustom: false,
		index: at + 1,
	};
}

/**
 * Ask on screen: one question as a list, several as tabs. Answers what
 * was picked, or nothing when the person cancelled or `closer` closed it.
 */
async function answersOnScreen(
	ctx: ExtensionContext,
	questions: Question[],
	closer: PromptCloser,
): Promise<Map<string, Answer> | null> {
	const answers = new Map<string, Answer>();
	const [only] = questions;
	if (only && questions.length === 1) {
		const result = await promptSingle(ctx, {
			content: (theme: Theme, width: number) =>
				renderMarkdown(only.prompt, theme, width),
			options: buildOptions(only),
			want: { kind: "question", said: only.prompt, ask: wantAsk(only) },
			closer,
		});
		if (!result) return null;
		if (result.type === "option") {
			const answer = answerOf(only, result.value, result.editorText);
			if (answer) answers.set(only.id, answer);
		}
		return answers;
	}
	const items: PromptItem[] = questions.map((q) => ({
		label: q.label,
		views: [
			{
				key: "1",
				label: "Question",
				content: (theme: Theme, width: number) =>
					renderMarkdown(q.prompt, theme, width),
			},
		],
		options: buildOptions(q),
	}));
	const result = await promptTabbed(ctx, {
		items,
		autoResolve: true,
		want: {
			kind: "question",
			said: `${count(questions.length, "question")}: ${questions[0]?.prompt ?? ""}`,
		},
		closer,
	});
	if (!result) return null;
	for (const [index, itemResult] of result.items) {
		const q = questions[index];
		if (!q || itemResult.type !== "option") continue;
		const answer = answerOf(q, itemResult.value, itemResult.editorText);
		if (answer) answers.set(q.id, answer);
	}
	return answers;
}

/** The tool's result for questions the person answered. */
function answered(
	questions: Question[],
	answers: Map<string, Answer>,
): { content: { type: "text"; text: string }[]; details: AskResult } {
	const askResult: AskResult = {
		questions,
		answers: Array.from(answers.values()),
		cancelled: false,
	};
	const answerLines = askResult.answers.map((a) => {
		const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
		if (a.wasCustom) return `${qLabel}: user wrote: ${a.label}`;
		return `${qLabel}: user selected: ${a.index}. ${a.label}`;
	});
	return {
		content: [{ type: "text", text: answerLines.join("\n") }],
		details: askResult,
	};
}

export default function ask(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface. Give each question the context it needs to be answered cold and a recommended option; while the user is away the recommendation is taken without asking.",
		parameters: AskParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (isAway() && params.questions.length > 0) {
				const questions: Question[] = params.questions.map((q, i) => ({
					...q,
					label: q.label || `Q${i + 1}`,
					allowOther: q.allowOther !== false,
				}));
				return {
					content: [{ type: "text", text: answerWhileAway(questions) }],
					details: { questions, answers: [], cancelled: false },
				};
			}
			if (!ctx.hasUI) {
				return errorResult(
					"Error: UI not available (running in non-interactive mode)",
				);
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// We normalize the questions with their defaults.
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			// Nobody there to answer: park at once rather than hold the turn.
			const session = ctx.sessionManager.getSessionId();
			const gone = absence(runtimeDir());
			if (gone) return parked(questions, session, gone);
			const closing = new AbortController();
			let parkedFor: ParkReason | undefined;
			const stopWatching = watchToPark(
				(reason) => {
					parkedFor = reason;
					closing.abort();
				},
				{
					afterMs: PARK_AFTER_MS,
					everyMs: ABSENCE_EVERY_MS,
					absent: () => absence(runtimeDir()),
				},
			);
			const closer: PromptCloser = {
				signal: closing.signal,
				verdict: `${OUTCOME_GLYPH.cancelled} ${PARKED_SAID}`,
			};
			try {
				const answers = await answersOnScreen(ctx, questions, closer);
				if (parkedFor) return parked(questions, session, parkedFor);
				if (!answers) {
					return {
						content: [{ type: "text", text: "User cancelled" }],
						details: { questions, answers: [], cancelled: true },
					};
				}
				return answered(questions, answers);
			} finally {
				stopWatching();
			}
		},

		renderCall(args, theme, context) {
			const qs = (args.questions as Question[]) || [];
			const labels = qs.map((q) => q.label || q.id).join(", ");
			return renderToolCall(
				{
					tool: "ask",
					action: count(qs.length, "question"),
					subject: labels,
				},
				theme,
				asText(context?.lastComponent),
			);
		},

		renderResult(result, _options, theme, context) {
			const details = result.details as AskResult | undefined;
			if (!details) {
				return drawInto(context?.lastComponent, firstText(result));
			}
			if (details.cancelled) {
				return drawInto(
					context?.lastComponent,
					theme.fg("dim", `${OUTCOME_GLYPH.cancelled} cancelled`),
				);
			}
			if (details.parked) {
				return drawInto(
					context?.lastComponent,
					theme.fg("muted", `${OUTCOME_GLYPH.cancelled} ${PARKED_SAID}`),
				);
			}
			// Answered while the user was away: the text says how.
			if (details.answers.length === 0) {
				return drawInto(
					context?.lastComponent,
					theme.fg("muted", firstText(result)),
				);
			}
			// The question muted and the answer plain: the answer is what was
			// said, and the accent is kept for where the keys go.
			const done = theme.fg("success", `${OUTCOME_GLYPH.done} `);
			const lines = details.answers.map((a) => {
				const asked = theme.fg("muted", `${a.id}:`);
				if (a.wasCustom) {
					return `${done}${asked} ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${done}${asked} ${display}`;
			});
			return drawInto(context?.lastComponent, lines.join("\n"));
		},
	});
}
