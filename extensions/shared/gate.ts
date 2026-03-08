/**
 * Gate — approval dialog for user decisions.
 *
 * Thin wrapper over showPanel that auto-appends a "Steer"
 * option with an inline editor pre-filled with context.
 * Maps PanelResult to the existing GateResult shape used
 * by guardians, tdd-mode, and pr-review.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { type PanelOption, showPanel } from "./panel.js";

// ---- Types ----

export interface GateOption {
	label: string;
	value: string;
	/** Optional description shown below the label. */
	description?: string;
}

export interface GateConfig {
	/** Renders the content section. */
	content: (theme: Theme, width: number) => string[];
	/** Selectable options. Steer is auto-appended. */
	options: GateOption[];
	/** Pre-fill text for the steer editor. */
	steerContext?: string;
}

export interface GateResult {
	/** The selected option's value, or "steer". */
	value: string;
	/** Present only when value is "steer". */
	feedback?: string;
}

// ---- Gate ----

/**
 * Show an approval gate. Auto-appends a "Steer" option that
 * opens an inline editor. Returns the selected option or
 * null on cancel.
 */
export async function showGate(
	ctx: ExtensionContext,
	config: GateConfig,
): Promise<GateResult | null> {
	// Build panel options from gate options + steer
	const panelOptions: PanelOption[] = config.options.map((opt) => ({
		label: opt.label,
		value: opt.value,
		description: opt.description,
	}));

	panelOptions.push({
		label: "Steer",
		value: "steer",
		opensEditor: true,
		editorPreFill: config.steerContext ?? "",
	});

	const result = await showPanel(ctx, {
		page: {
			label: "",
			content: config.content,
			options: panelOptions,
		},
	});

	if (!result) return null;

	// Map panel result to gate result
	if (result.value === "steer" && result.editorText) {
		return { value: "steer", feedback: result.editorText };
	}

	return { value: result.value };
}

// ---- Steer result helper ----

/** Formats a steer result into a block reason for tool_call handlers. */
export function formatSteer(
	feedback: string,
	context: string,
): { block: true; reason: string } {
	return {
		block: true,
		reason: [
			"User wants a different approach.",
			"",
			`Feedback: ${feedback}`,
			"",
			context,
			"",
			"Adjust based on the feedback and try again.",
		].join("\n"),
	};
}
