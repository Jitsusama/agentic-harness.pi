/**
 * Refactor gate — tabbed panel for reviewing refactoring
 * suggestions before acting on them. Each suggestion is a
 * tab. Users can approve, reject, or add their own.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type PanelPage,
	type SeriesSelection,
	showPanelSeries,
} from "../lib/ui/panel.js";
import {
	CONTENT_INDENT,
	FALLBACK_CONTENT_WIDTH,
	wordWrap,
} from "../lib/ui/text.js";

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
	userSuggestion?: string;
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
			const padded =
				width > 0 ? width - CONTENT_INDENT * 2 : FALLBACK_CONTENT_WIDTH;
			const lines: string[] = [];
			lines.push(theme.fg("text", ` Refactoring ${index + 1} of ${total}`));
			lines.push(theme.fg("accent", ` ${suggestion.label}`));
			lines.push("");
			for (const line of wordWrap(suggestion.description, padded)) {
				lines.push(theme.fg("muted", `  ${line}`));
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
	hasUserSuggestion: boolean,
): PanelPage {
	return {
		label: "Done",
		content: (theme) => {
			const lines: string[] = [];
			lines.push(theme.fg("text", " All suggestions reviewed."));
			if (approvedCount > 0) {
				lines.push(theme.fg("success", ` ${approvedCount} approved.`));
			}
			if (hasUserSuggestion) {
				lines.push(theme.fg("accent", " + your suggestion"));
			}
			return lines;
		},
		options: [
			{ label: "Done", value: "done", icon: "✓" },
			{
				label: "Add my own",
				value: "add",
				icon: "✎",
				opensEditor: true,
				editorPreFill: "",
			},
		],
	};
}

/**
 * Show the refactor gate. Returns approved suggestions and
 * optional user-provided suggestion, or null on cancel.
 */
export async function showRefactorGate(
	ctx: ExtensionContext,
	suggestions: RefactorSuggestion[],
): Promise<RefactorGateResult | null> {
	if (!ctx.hasUI) {
		return { approved: suggestions, rejected: 0 };
	}

	// No suggestions — just offer the user a chance to add their own
	if (suggestions.length === 0) {
		const result = await showPanelSeries(ctx, {
			pages: [buildDonePage(0, false)],
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
				approved: [],
				rejected: 0,
				userSuggestion: sel.editorText.trim(),
			};
		}
		return { approved: [], rejected: 0 };
	}

	const statuses = new Map<number, SuggestionStatus>();
	let userSuggestion: string | undefined;

	function buildPages(): PanelPage[] {
		const suggestionPages = suggestions.map((s, i) =>
			buildSuggestionPage(s, i, suggestions.length, statuses),
		);
		const approvedCount = Array.from(statuses.values()).filter(
			(s) => s === "approved",
		).length;
		return [...suggestionPages, buildDonePage(approvedCount, !!userSuggestion)];
	}

	async function onSelect(
		selection: SeriesSelection,
		_all: Map<number, SeriesSelection>,
	): Promise<boolean> {
		const { pageIndex, value, editorText } = selection;

		// Done page
		if (pageIndex === suggestions.length) {
			if (value === "done") return true;
			if (value === "add" && editorText?.trim()) {
				userSuggestion = editorText.trim();
			}
			return false;
		}

		// Suggestion page
		if (value === "approve") {
			statuses.set(pageIndex, "approved");
		} else if (value === "reject") {
			statuses.set(pageIndex, "rejected");
		}

		return false;
	}

	const result = await showPanelSeries(ctx, {
		pages: buildPages(),
		onSelect,
	});

	if (!result) return null;

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

	return { approved, rejected, userSuggestion };
}
