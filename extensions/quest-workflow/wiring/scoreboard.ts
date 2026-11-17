/**
 * The loaded quest's one line on screen, the scoreboard: what it is
 * given and how it repaints. It changes when the line shows something
 * new, not when the quest does.
 */

import { renderWidget } from "../render.ts";
import type { QuestState } from "../state.ts";

/** The minimal render component pi's setWidget callback form returns. */
interface WidgetComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

type Theme = import("@earendil-works/pi-coding-agent").Theme;

interface UiSink {
	setStatus(key: string, value: string | undefined): void;
	setWidget(
		key: string,
		value:
			| string[]
			| ((tui: unknown, theme: Theme) => WidgetComponent)
			| undefined,
	): void;
	theme: Theme;
}

/**
 * Paint the loaded quest into its widget, the quest's one line.
 *
 * The widget uses pi's callback form, whose `render(width)` the TUI
 * re-invokes on every paint, including a resize, with the live width,
 * so the line re-truncates to the new width.
 *
 * The footer slot is cleared rather than left alone: a session that
 * reloaded from a version which drew the quest there would otherwise
 * keep the old text until it ended.
 */
export function updateScoreboard(state: QuestState, ctx: { ui: UiSink }): void {
	const live = state.questId !== null;
	ctx.ui.setStatus("quest-workflow", undefined);
	const widgetInput = {
		questId: state.questId,
		questKind: state.questKind,
		questStatus: state.questStatus,
		questTitle: state.questTitle,
		documentKind: state.documentKind,
		documentStage: state.documentStage,
		documentTitle: state.documentTitle,
		done: state.done,
		total: state.total,
		currentItem: state.currentItem,
	};
	ctx.ui.setWidget(
		"quest-workflow",
		!live
			? undefined
			: (_tui: unknown, theme: Theme): WidgetComponent => ({
					render: (width: number) => renderWidget(widgetInput, theme, width),
					invalidate() {},
				}),
	);
}
