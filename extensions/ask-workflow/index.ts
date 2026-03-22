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
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { prompt } from "../lib/ui/panel.js";
import type { Option, PromptItem } from "../lib/ui/types.js";

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

/** Build options for a question, including the "Type something" option. */
function buildOptions(q: Question): Option[] {
	const opts: Option[] = q.options.map((o) => ({
		label: o.label,
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
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
		parameters: AskParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

				const result = await prompt(ctx, {
					content: (theme: Theme) => [theme.fg("text", ` ${q.prompt}`)],
					options: buildOptions(q),
				});

				if (!result) {
					return {
						content: [{ type: "text", text: "User cancelled" }],
						details: { questions, answers: [], cancelled: true },
					};
				}

				if (result.type === "action") {
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
							content: (theme: Theme) => [theme.fg("text", ` ${q.prompt}`)],
						},
					],
					options: buildOptions(q),
				}));

				const result = await prompt(ctx, {
					items,
					autoResolve: true,
				});

				if (!result) {
					return {
						content: [{ type: "text", text: "User cancelled" }],
						details: { questions, answers: [], cancelled: true },
					};
				}

				for (const [index, itemResult] of result.items) {
					const q = questions[index];
					if (!q || itemResult.type !== "action") continue;

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

		renderCall(args, theme) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("ask "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
