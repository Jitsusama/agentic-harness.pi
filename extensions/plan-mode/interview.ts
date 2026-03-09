/**
 * Plan interview — tabbed panel for answering planning
 * questions. Each question is a tab with an answer editor.
 * Users can answer, skip, or add their own questions.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type PanelPage,
	type SeriesSelection,
	showPanelSeries,
} from "../lib/ui/panel.js";
import { wordWrap } from "../lib/ui/text.js";

export interface PlanQuestion {
	id: string;
	question: string;
	context?: string;
}

export interface PlanInterviewResult {
	answers: { id: string; question: string; answer: string }[];
	userQuestions: string[];
	allSkipped: boolean;
}

function buildQuestionPage(
	q: PlanQuestion,
	index: number,
	total: number,
	answers: Map<string, string>,
): PanelPage {
	const answered = answers.has(q.id);
	const icon = answered ? "✓" : "";
	const tab = icon ? `${icon} Q${index + 1}` : `Q${index + 1}`;

	return {
		label: tab,
		content: (theme, _width) => {
			const cols = process.stdout.columns;
			const padded = cols && cols > 0 ? cols - 6 : 72;
			const lines: string[] = [];
			lines.push(theme.fg("text", ` Question ${index + 1} of ${total}`));
			lines.push("");
			for (const line of wordWrap(q.question, padded)) {
				lines.push(theme.fg("accent", `  ${line}`));
			}
			if (q.context) {
				lines.push("");
				for (const line of wordWrap(q.context, padded)) {
					lines.push(theme.fg("dim", `  ${line}`));
				}
			}
			const existing = answers.get(q.id);
			if (existing) {
				lines.push("");
				lines.push(theme.fg("success", "  Current answer:"));
				for (const line of wordWrap(existing, padded)) {
					lines.push(theme.fg("muted", `  ${line}`));
				}
			}
			return lines;
		},
		options: [
			{
				label: answered ? "Update answer" : "Answer",
				value: "answer",
				icon: "✎",
				opensEditor: true,
				editorPreFill: answers.get(q.id) ?? "",
			},
			{ label: "Skip", value: "skip" },
		],
	};
}

function buildDonePage(
	answeredCount: number,
	total: number,
	userQuestionCount: number,
): PanelPage {
	return {
		label: "Done",
		content: (theme) => {
			const lines: string[] = [];
			if (answeredCount > 0) {
				lines.push(theme.fg("success", ` ${answeredCount}/${total} answered.`));
			} else {
				lines.push(theme.fg("muted", " No questions answered yet."));
			}
			if (userQuestionCount > 0) {
				lines.push(theme.fg("accent", ` + ${userQuestionCount} of your own`));
			}
			return lines;
		},
		options: [
			{ label: "Done", value: "done", icon: "✓" },
			{
				label: "Ask my own question",
				value: "add",
				icon: "✎",
				opensEditor: true,
				editorPreFill: "",
			},
		],
	};
}

/**
 * Show the plan interview. Returns answers and user questions,
 * or null on cancel.
 */
export async function showPlanInterview(
	ctx: ExtensionContext,
	questions: PlanQuestion[],
): Promise<PlanInterviewResult | null> {
	if (!ctx.hasUI) {
		return { answers: [], userQuestions: [], allSkipped: true };
	}

	if (questions.length === 0) {
		const result = await showPanelSeries(ctx, {
			pages: [buildDonePage(0, 0, 0)],
			onSelect: (sel) => {
				if (sel.value === "done") return true;
				if (sel.value === "add" && sel.editorText?.trim()) return true;
				return false;
			},
		});

		if (!result) return null;

		const sel = result.get(0);
		if (sel?.value === "add" && sel.editorText?.trim()) {
			return {
				answers: [],
				userQuestions: [sel.editorText.trim()],
				allSkipped: false,
			};
		}
		return { answers: [], userQuestions: [], allSkipped: true };
	}

	const answers = new Map<string, string>();
	const userQuestions: string[] = [];

	function buildPages(): PanelPage[] {
		const questionPages = questions.map((q, i) =>
			buildQuestionPage(q, i, questions.length, answers),
		);
		return [
			...questionPages,
			buildDonePage(answers.size, questions.length, userQuestions.length),
		];
	}

	async function onSelect(
		selection: SeriesSelection,
		_all: Map<number, SeriesSelection>,
	): Promise<boolean> {
		const { pageIndex, value, editorText } = selection;

		// Done page
		if (pageIndex === questions.length) {
			if (value === "done") return true;
			if (value === "add" && editorText?.trim()) {
				userQuestions.push(editorText.trim());
			}
			return false;
		}

		// Question page
		const q = questions[pageIndex];
		if (!q) return false;

		if (value === "answer" && editorText?.trim()) {
			answers.set(q.id, editorText.trim());
		}
		// skip = just move to next tab

		return false;
	}

	const result = await showPanelSeries(ctx, {
		pages: buildPages(),
		onSelect,
	});

	if (!result) return null;

	const answeredList = questions
		.filter((q) => answers.has(q.id))
		.map((q) => ({
			id: q.id,
			question: q.question,
			answer: answers.get(q.id) ?? "",
		}));

	return {
		answers: answeredList,
		userQuestions,
		allSkipped: answeredList.length === 0 && userQuestions.length === 0,
	};
}
