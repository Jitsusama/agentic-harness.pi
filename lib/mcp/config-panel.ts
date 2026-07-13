import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	promptToggleList,
	type ToggleSection,
} from "../ui/prompt-toggle-list.js";

/** The settings surface for a server, as titled sections of toggle rows. Server-agnostic: all data is injected. */
export interface SurfaceConfigPanelInput {
	title?: string;
	sections: ToggleSection[];
}

/** The panel outcome: every row's value, and just the rows that changed. */
export interface SurfaceConfigPanelResult {
	values: Record<string, string>;
	changed: Record<string, string>;
}

/** The rows whose selected value differs from their initial selection. */
export function changedValues(
	input: SurfaceConfigPanelInput,
	values: Record<string, string>,
): Record<string, string> {
	const changed: Record<string, string> = {};
	for (const section of input.sections) {
		for (const row of section.rows) {
			const initial = row.options[row.index];
			if (values[row.id] !== undefined && values[row.id] !== initial)
				changed[row.id] = values[row.id];
		}
	}
	return changed;
}

/**
 * Present the settings surface and return the selection, or null when nothing
 * changed (including a headless context, where no edit is possible). The caller
 * decides what to persist and whether to prompt an apply gate.
 */
export async function runSurfaceConfigPanel(
	ctx: ExtensionContext,
	input: SurfaceConfigPanelInput,
): Promise<SurfaceConfigPanelResult | null> {
	const values = await promptToggleList(ctx, {
		title: input.title ?? "Configure",
		sections: input.sections,
	});
	const changed = changedValues(input, values);
	if (Object.keys(changed).length === 0) return null;
	return { values, changed };
}
