/**
 * Pipeline progress: horizontal multi-stage indicator for
 * pipelines that march through named stages with per-stage
 * outcomes.
 *
 * Useful for any workflow that the user wants to watch progress
 * on at a glance: council pipelines, TDD red/green/refactor
 * cycles, quest-workflow think/draft/build stages, mastery
 * layer transitions.
 *
 * Single-line render of stages separated by a connector, each
 * stage themed by its outcome state. The current stage is
 * highlighted; finished stages render checked; skipped stages
 * are dimmed.
 *
 * Example:
 *
 *     ✓ R1 fanout ─▸ ◈ R2 judge ─▸ ◇ ask ─▸ ◇ critique ─▸ ◇ R4 you
 *     (complete)    (running)     (pending)  (pending)    (pending)
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";

/** Possible state of a single stage. */
export type StageState =
	| "pending"
	| "running"
	| "complete"
	| "skipped"
	| "failed";

/** Definition of a single stage in the pipeline. */
export interface PipelineStage {
	/** Short label shown next to the state glyph. */
	label: string;
	/** Outcome / current state. */
	state: StageState;
	/** Optional secondary text (e.g., "3/5" for a fan-out, "42s" for elapsed). */
	subtext?: string;
}

/** Options for `renderPipelineProgress`. */
export interface PipelineProgressOptions {
	/** Glyph used between stages. Default: `─▸`. */
	connector?: string;
	/** Render each stage on its own line (vertical). Default: false. */
	vertical?: boolean;
	/** Show the subtext when present. Default: true. */
	showSubtext?: boolean;
}

/** Glyph and colour for each state. */
const STATE_STYLE: Record<StageState, { glyph: string; color: ThemeColor }> = {
	pending: { glyph: "◇", color: "muted" },
	running: { glyph: "◈", color: "accent" },
	complete: { glyph: "✓", color: "success" },
	skipped: { glyph: "·", color: "dim" },
	failed: { glyph: "✕", color: "error" },
};

/**
 * Render a multi-stage pipeline to a single string (horizontal)
 * or an array of strings (vertical).
 *
 * Returns a single string when horizontal; an array of strings
 * (one per stage) when vertical. Callers can adapt by always
 * receiving `string[]` via `renderPipelineProgressLines`.
 */
export function renderPipelineProgress(
	stages: PipelineStage[],
	theme: Theme,
	options?: PipelineProgressOptions,
): string | string[] {
	const vertical = options?.vertical ?? false;
	const showSubtext = options?.showSubtext ?? true;
	const connector = options?.connector ?? "─▸";

	const rendered = stages.map((stage) => {
		const style = STATE_STYLE[stage.state];
		const glyph = theme.fg(style.color, style.glyph);
		const label =
			stage.state === "running"
				? theme.fg("accent", theme.bold(stage.label))
				: stage.state === "skipped"
					? theme.fg("dim", stage.label)
					: theme.fg(style.color, stage.label);
		const subtext =
			showSubtext && stage.subtext
				? ` ${theme.fg("dim", `(${stage.subtext})`)}`
				: "";
		return `${glyph} ${label}${subtext}`;
	});

	if (vertical) return rendered;

	const sep = ` ${theme.fg("dim", connector)} `;
	return rendered.join(sep);
}

/**
 * Convenience wrapper that always returns `string[]`, suitable
 * for callers that pass output directly to a panel content
 * renderer.
 */
export function renderPipelineProgressLines(
	stages: PipelineStage[],
	theme: Theme,
	options?: PipelineProgressOptions,
): string[] {
	const out = renderPipelineProgress(stages, theme, options);
	return typeof out === "string" ? [out] : out;
}
