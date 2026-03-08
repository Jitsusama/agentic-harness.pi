/**
 * Ask — reusable structured question tool.
 *
 * Single question: simple options list.
 * Multiple questions: tab bar navigation between questions.
 * Always includes a free-form "Type something" option.
 *
 * Composes on showPanelSeries for the UI. Each question is a
 * PanelPage; multi-question mode adds a Submit page.
 *
 * Standalone — any skill or extension can rely on this tool
 * being available (planning, TDD, general conversation).
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	type PanelOption,
	type PanelPage,
	type SeriesSelection,
	showPanelSeries,
} from "../lib/ui/panel.js";

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

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			const isMulti = questions.length > 1;
			const answers = new Map<string, Answer>();

			// Build a PanelPage for each question
			const questionPages: PanelPage[] = questions.map((q) => {
				const opts: PanelOption[] = q.options.map((o) => ({
					label: o.label,
					value: o.value,
					description: o.description,
				}));

				if (q.allowOther) {
					opts.push({
						label: "Type something",
						value: "__other__",
						icon: "✎",
						opensEditor: true,
						editorPreFill: "",
					});
				}

				return {
					label: q.label,
					content: (theme: Theme, _width: number) => [
						theme.fg("text", ` ${q.prompt}`),
					],
					options: opts,
				};
			});

			// Submit page for multi-question mode
			const submitPage: PanelPage = {
				label: "✓ Submit",
				content: (theme: Theme, _width: number) => {
					const lines: string[] = [];
					lines.push(theme.fg("accent", theme.bold(" Ready to submit")));
					lines.push("");
					for (const question of questions) {
						const answer = answers.get(question.id);
						if (answer) {
							const prefix = answer.wasCustom ? "(wrote) " : "";
							lines.push(
								`${theme.fg("muted", ` ${question.label}: `)}` +
									`${theme.fg("text", prefix + answer.label)}`,
							);
						}
					}
					lines.push("");
					const allAnswered = questions.every((q) => answers.has(q.id));
					if (allAnswered) {
						lines.push(theme.fg("success", " Press Enter to submit"));
					} else {
						const missing = questions
							.filter((q) => !answers.has(q.id))
							.map((q) => q.label)
							.join(", ");
						lines.push(theme.fg("warning", ` Unanswered: ${missing}`));
					}
					return lines;
				},
				options: [{ label: "Submit", value: "__submit__", icon: "✓" }],
			};

			const pages = isMulti ? [...questionPages, submitPage] : questionPages;

			// onSelect callback — track answers and decide when to resolve
			function onSelect(
				selection: SeriesSelection,
				_all: Map<number, SeriesSelection>,
			): boolean {
				// Submit page
				if (isMulti && selection.pageIndex === questionPages.length) {
					if (selection.value === "__submit__") {
						return questions.every((q) => answers.has(q.id));
					}
					return false;
				}

				// Question page — record the answer
				const question = questions[selection.pageIndex];
				if (!question) return false;

				if (selection.value === "__other__" && selection.editorText) {
					const text = selection.editorText;
					answers.set(question.id, {
						id: question.id,
						value: text,
						label: text,
						wasCustom: true,
					});
				} else {
					// Find the option index (1-based)
					const optIdx = question.options.findIndex(
						(o) => o.value === selection.value,
					);
					const opt = question.options[optIdx];
					if (opt) {
						answers.set(question.id, {
							id: question.id,
							value: opt.value,
							label: opt.label,
							wasCustom: false,
							index: optIdx + 1,
						});
					}
				}

				// Single question — resolve immediately
				if (!isMulti) return true;

				return false;
			}

			const seriesResult = await showPanelSeries(ctx, {
				pages,
				onSelect,
			});

			// Cancelled
			if (!seriesResult) {
				const result: AskResult = {
					questions,
					answers: [],
					cancelled: true,
				};
				return {
					content: [{ type: "text", text: "User cancelled" }],
					details: result,
				};
			}

			// Build result from accumulated answers
			const result: AskResult = {
				questions,
				answers: Array.from(answers.values()),
				cancelled: false,
			};

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
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
