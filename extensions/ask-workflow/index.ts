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
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { decide, isAway } from "../../lib/internal/away/state.ts";
import { count } from "../../lib/ui/count.ts";
import {
	asText,
	drawInto,
	firstText,
	type ListChoice,
	OUTCOME_GLYPH,
	type PromptItem,
	promptSingle,
	promptTabbed,
	renderMarkdown,
	renderToolCall,
} from "../../lib/ui/index.ts";

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

			const isMulti = questions.length > 1;
			const answers = new Map<string, Answer>();

			if (!isMulti) {
				// Single question: simple prompt with options
				const q = questions[0];
				if (!q) return errorResult("Error: Empty question");

				const result = await promptSingle(ctx, {
					content: (theme: Theme, width: number) =>
						renderMarkdown(q.prompt, theme, width),
					options: buildOptions(q),
					want: { kind: "question", said: q.prompt },
				});

				if (!result) {
					return {
						content: [{ type: "text", text: "User cancelled" }],
						details: { questions, answers: [], cancelled: true },
					};
				}

				if (result.type === "option") {
					if (result.value === "__other__" && result.editorText) {
						answers.set(q.id, {
							id: q.id,
							value: result.editorText,
							label: result.editorText,
							wasCustom: true,
						});
					} else {
						const optIdx = q.options.findIndex((o) => o.value === result.value);
						const opt = q.options[optIdx];
						if (opt) {
							answers.set(q.id, {
								id: q.id,
								value: opt.value,
								label: opt.label,
								wasCustom: false,
								index: optIdx + 1,
							});
						}
					}
				}
			} else {
				// Multiple questions: tabbed prompt
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
				});

				if (!result) {
					return {
						content: [{ type: "text", text: "User cancelled" }],
						details: { questions, answers: [], cancelled: true },
					};
				}

				for (const [index, itemResult] of result.items) {
					const q = questions[index];
					if (!q || itemResult.type !== "option") continue;

					if (itemResult.value === "__other__" && itemResult.editorText) {
						answers.set(q.id, {
							id: q.id,
							value: itemResult.editorText,
							label: itemResult.editorText,
							wasCustom: true,
						});
					} else {
						const optIdx = q.options.findIndex(
							(o) => o.value === itemResult.value,
						);
						const opt = q.options[optIdx];
						if (opt) {
							answers.set(q.id, {
								id: q.id,
								value: opt.value,
								label: opt.label,
								wasCustom: false,
								index: optIdx + 1,
							});
						}
					}
				}
			}

			// We build the result from the accumulated answers.
			const askResult: AskResult = {
				questions,
				answers: Array.from(answers.values()),
				cancelled: false,
			};

			const answerLines = askResult.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: askResult,
			};
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
