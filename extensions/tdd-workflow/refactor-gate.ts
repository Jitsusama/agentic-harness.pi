/**
 * Refactor gate: tabbed prompt for reviewing refactoring
 * suggestions. Each suggestion is a tab with approve/reject
 * actions. Users can add their own via '+' hotkey.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	contentWrapWidth,
	type PromptItem,
	promptTabbed,
	renderMarkdown,
} from "../../lib/ui/index.js";

/** A single refactoring suggestion presented in the gate. */
export interface RefactorSuggestion {
	label: string;
	description: string;
}

/** Result of a completed refactor gate session. */
export interface RefactorGateResult {
	approved: RefactorSuggestion[];
	rejected: number;
	userSuggestions: string[];
}

function buildSuggestionItem(
	suggestion: RefactorSuggestion,
	index: number,
	total: number,
): PromptItem {
	return {
		label: `R${index + 1}`,
		views: [
			{
				key: "r",
				label: "Refactoring",
				content: (theme, width) => {
					const padded = contentWrapWidth(width);
					const lines: string[] = [];
					lines.push(theme.fg("text", ` Refactoring ${index + 1} of ${total}`));
					lines.push(theme.fg("accent", ` ${suggestion.label}`));
					lines.push("");
					for (const line of renderMarkdown(
						suggestion.description,
						theme,
						padded,
					)) {
						lines.push(line);
					}
					return lines;
				},
			},
		],
		actions: [{ key: "r", label: "Reject" }],
	};
}

/**
 * Show the refactor gate. Returns approved suggestions and
 * user-provided suggestions, or null on cancel.
 */
export async function showRefactorGate(
	ctx: ExtensionContext,
	suggestions: RefactorSuggestion[],
): Promise<RefactorGateResult | null> {
	if (!ctx.hasUI) {
		return { approved: suggestions, rejected: 0, userSuggestions: [] };
	}

	const items = suggestions.map((s, i) =>
		buildSuggestionItem(s, i, suggestions.length),
	);

	const result = await promptTabbed(ctx, {
		items,
		canAddItems: true,
		autoResolve: false,
	});

	if (!result) return null;

	const approved: RefactorSuggestion[] = [];
	let rejected = 0;

	for (let i = 0; i < suggestions.length; i++) {
		const itemResult = result.items.get(i);
		if (!itemResult) continue;
		const suggestion = suggestions[i];
		if (!suggestion) continue;

		if (itemResult.type === "action" && itemResult.key === "__enter__") {
			approved.push(suggestion);
		} else if (itemResult.type === "action" && itemResult.key === "r") {
			rejected++;
		}
	}

	return { approved, rejected, userSuggestions: result.userItems };
}
