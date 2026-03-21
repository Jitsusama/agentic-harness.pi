/**
 * Plan interview: tabbed prompt for answering planning
 * questions. Each question is a tab with answer/skip actions.
 * Users can add their own questions via '+' hotkey.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { renderMarkdown } from "../lib/ui/content-renderer.js";
import { prompt } from "../lib/ui/panel.js";
import { contentWrapWidth } from "../lib/ui/text.js";
import type { PromptItem } from "../lib/ui/types.js";

/** A single question presented during the plan interview. */
export interface PlanQuestion {
	id: string;
	question: string;
	context?: string;
}

/** Result of a completed plan interview session. */
export interface PlanInterviewResult {
	answers: { id: string; question: string; answer: string }[];
	userQuestions: string[];
	allSkipped: boolean;
}

function buildQuestionItem(
	q: PlanQuestion,
	index: number,
	total: number,
): PromptItem {
	return {
		label: `Q${index + 1}`,
		views: [
			{
				key: "1",
				label: "Question",
				content: (theme, width) => {
					const padded = contentWrapWidth(width);
					const lines: string[] = [];
					lines.push(theme.fg("text", ` Question ${index + 1} of ${total}`));
					lines.push("");
					for (const line of renderMarkdown(q.question, theme, padded)) {
						lines.push(line);
					}
					if (q.context) {
						lines.push("");
						for (const line of renderMarkdown(q.context, theme, padded)) {
							lines.push(line);
						}
					}
					return lines;
				},
			},
		],
		options: [
			{
				label: "Answer",
				value: "answer",
				opensEditor: true,
			},
			{ label: "Skip", value: "skip" },
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
		// If there are no questions, we just offer to add custom ones.
		const result = await prompt(ctx, {
			content: (theme) => [
				theme.fg("muted", " No questions to answer."),
				"",
				theme.fg("dim", " Press + to add your own question, or Esc to close."),
			],
			items: [],
			canAddItems: true,
		});

		if (!result || result.type !== "object") {
			return null;
		}

		// The result is a TabbedResult.
		const tabbed = result as unknown as { userItems: string[] };
		if (tabbed.userItems?.length > 0) {
			return {
				answers: [],
				userQuestions: tabbed.userItems,
				allSkipped: false,
			};
		}
		return { answers: [], userQuestions: [], allSkipped: true };
	}

	const items = questions.map((q, i) =>
		buildQuestionItem(q, i, questions.length),
	);

	const result = await prompt(ctx, {
		items,
		canAddItems: true,
		autoResolve: false,
	});

	if (!result) return null;

	// We extract answers from the tabbed results.
	const answers: { id: string; question: string; answer: string }[] = [];
	for (const [index, itemResult] of result.items) {
		const q = questions[index];
		if (!q) continue;
		if (
			itemResult.type === "action" &&
			itemResult.value === "answer" &&
			itemResult.editorText?.trim()
		) {
			answers.push({
				id: q.id,
				question: q.question,
				answer: itemResult.editorText.trim(),
			});
		}
	}

	return {
		answers,
		userQuestions: result.userItems,
		allSkipped: answers.length === 0 && result.userItems.length === 0,
	};
}
