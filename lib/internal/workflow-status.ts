/**
 * Shared status line and detail widget management for workflow
 * extensions. Each workflow provides a config and a function
 * that builds the detail text; this module handles the guard
 * logic, glyph, colour, alignment and cleanup.
 *
 * Not part of the public library surface.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/** Glyph shown in the status bar when a workflow is active. */
const STATUS_GLYPH = "◈";

/** Configuration for a workflow's status line and detail widget. */
export interface WorkflowStatusConfig {
	/** Key for `setStatus` and `appendEntry`. E.g. `"pr-review"`. */
	statusKey: string;
	/** Key for `setWidget`. E.g. `"pr-review-detail"`. */
	widgetKey: string;
	/** Human label shown next to the glyph. E.g. `"PR Review"`. */
	label: string;
}

/**
 * State shape that every workflow must satisfy. The guard
 * clears both status and widget when the workflow is inactive.
 */
export interface WorkflowStatusState {
	enabled: boolean;
}

/**
 * Update the status line indicator and detail widget for a
 * workflow. Clears both when the workflow is inactive.
 *
 * @param config   Static config (key names, label).
 * @param state    Runtime state with at least `enabled`.
 * @param ctx      Extension context for UI calls.
 * @param buildDetail  Returns the detail text to show in the
 *   widget, or null to hide the widget while keeping the
 *   status indicator visible.
 */
export function updateWorkflowStatus(
	config: WorkflowStatusConfig,
	state: WorkflowStatusState,
	ctx: ExtensionContext,
	buildDetail: () => string | null,
): void {
	if (!state.enabled) {
		ctx.ui.setStatus(config.statusKey, undefined);
		ctx.ui.setWidget(config.widgetKey, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	ctx.ui.setStatus(
		config.statusKey,
		`${theme.fg("accent", STATUS_GLYPH)} ${theme.fg("muted", config.label)}`,
	);

	const detail = buildDetail();
	if (detail === null) {
		ctx.ui.setWidget(config.widgetKey, undefined);
		return;
	}

	ctx.ui.setWidget(config.widgetKey, (_tui, theme) => ({
		render(width: number): string[] {
			const truncated = truncateToWidth(detail, width);
			const text = theme.fg("dim", truncated);
			const pad = Math.max(0, width - visibleWidth(truncated));
			return [`${" ".repeat(pad)}${text}`];
		},
	}));
}
