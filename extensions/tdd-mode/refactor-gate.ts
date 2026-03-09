/**
 * Refactor gate — tabbed panel for reviewing refactoring
 * suggestions before acting on them. Each suggestion is a
 * tab. Users can approve, reject, or add their own.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { renderMarkdown } from "../lib/ui/content-renderer.js";
import {
	type PanelPage,
	type SeriesSelection,
	showPanelSeries,
} from "../lib/ui/panel.js";
import { contentWrapWidth } from "../lib/ui/text.js";

/** A single refactoring suggestion presented in the gate. */
export interface RefactorSuggestion {
	label: string;
	description: string;
}

type SuggestionStatus = "pending" | "approved" | "rejected";

/** Result of a completed refactor gate session. */
export interface RefactorGateResult {
	approved: RefactorSuggestion[];
	rejected: number;
	userSuggestions: string[];
}

function buildSuggestionPage(
	suggestion: RefactorSuggestion,
	index: number,
	total: number,
	statuses: Map<number, SuggestionStatus>,
): PanelPage {
	const status = statuses.get(index) ?? "pending";
	const icon = status === "approved" ? "✓" : status === "rejected" ? "✗" : "";
	const tab = icon ? `${icon} R${index + 1}` : `R${index + 1}`;

	return {
		label: tab,
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
		options: [
			{ label: "Approve", value: "approve", icon: "✓" },
			{ label: "Reject", value: "reject", icon: "✗" },
		],
	};
}

function buildDonePage(
	approvedCount: number,
	userSuggestions: string[],
): PanelPage {
	return {
		label: "Done",
		content: (theme, width) => {
			const padded = contentWrapWidth(width);
			const lines: string[] = [];
			lines.push(theme.fg("text", " Review complete."));
			if (approvedCount > 0) {
				lines.push(theme.fg("success", ` ${approvedCount} approved.`));
			}
			if (userSuggestions.length > 0) {
				lines.push("");
				lines.push(theme.fg("accent", " Your suggestions:"));
				for (let i = 0; i < userSuggestions.length; i++) {
					const s = userSuggestions[i];
					if (s) {
						lines.push("");
						const rendered = renderMarkdown(s, theme, padded - 4);
						for (let j = 0; j < rendered.length; j++) {
							const prefix = j === 0 ? theme.fg("text", ` ${i + 1}. `) : "    ";
							lines.push(`${prefix}${rendered[j]}`);
						}
					}
				}
			}
			return lines;
		},
		options: [
			{ label: "Done", value: "done", icon: "✓" },
			{
				label: "Add another",
				value: "add",
				icon: "✎",
				opensEditor: true,
				editorPreFill: "",
			},
			...(userSuggestions.length > 0
				? [{ label: "Clear all", value: "clear", icon: "✗" }]
				: []),
		],
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

	const statuses = new Map<number, SuggestionStatus>();
	const userSuggestions: string[] = [];

	function buildPages(): PanelPage[] {
		const suggestionPages = suggestions.map((s, i) =>
			buildSuggestionPage(s, i, suggestions.length, statuses),
		);
		const approvedCount = Array.from(statuses.values()).filter(
			(s) => s === "approved",
		).length;
		return [...suggestionPages, buildDonePage(approvedCount, userSuggestions)];
	}

	async function onSelect(
		selection: SeriesSelection,
		_all: Map<number, SeriesSelection>,
	): Promise<boolean> {
		const { pageIndex, value, editorText } = selection;

		const donePageIndex = suggestions.length;

		// Done page
		if (pageIndex === donePageIndex) {
			if (value === "done") return true;
			if (value === "add" && editorText?.trim()) {
				userSuggestions.push(editorText.trim());
				return false; // Stay on Done page to show updated list
			}
			if (value === "clear") {
				userSuggestions.length = 0;
				return false; // Stay on Done page to show cleared list
			}
			return false;
		}

		// Agent suggestion page
		if (value === "approve") {
			statuses.set(pageIndex, "approved");
		} else if (value === "reject") {
			statuses.set(pageIndex, "rejected");
		}

		return false; // Let panel series navigate naturally
	}

	const result = await showPanelSeries(ctx, {
		pages: buildPages(),
		onSelect,
	});

	// User cancelled
	if (!result) return null;

	// Collect results
	const approved: RefactorSuggestion[] = [];
	let rejected = 0;

	for (let i = 0; i < suggestions.length; i++) {
		const status = statuses.get(i) ?? "pending";
		if (status === "approved") {
			const suggestion = suggestions[i];
			if (suggestion) approved.push(suggestion);
		} else if (status === "rejected") {
			rejected++;
		}
	}

	return { approved, rejected, userSuggestions };
}
