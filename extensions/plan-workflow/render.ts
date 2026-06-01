/**
 * The scoreboard's two surfaces, each with its own circle
 * vocabulary. The status line carries the lifecycle: a constant
 * "Plan" label beside a glyph that fills as the plan moves from
 * stage to stage. The widget carries completion: its leading
 * glyph is a progress meter that fills with the checkbox ratio,
 * with the stage named in the text alongside the step position
 * and the plan's title. Same shapes on two axes — lifecycle and
 * completion — but each glyph is labelled by its context, so they
 * never read ambiguously. Both fall silent at idle. These
 * produce strings only; lifecycle owns the setStatus and
 * setWidget calls.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { PlanSummary } from "./discovery.js";
import type { Stage } from "./machine.js";

/** Columns reserved for the glyph and the space after it. */
const GLYPH_COLS = 2;

/** Render plan summaries as aligned plain-text rows for `/plan list`. */
export function formatPlanList(plans: PlanSummary[]): string {
	const idWidth = Math.max(...plans.map((p) => p.id.length));
	const stageWidth = Math.max(...plans.map((p) => p.stage.length));
	return plans
		.map((p) => {
			const progress = p.total > 0 ? `${p.done}/${p.total}` : "-";
			const title = p.title ?? "(untitled)";
			return `${p.id.padEnd(idWidth)}  ${p.stage.padEnd(stageWidth)}  ${progress.padStart(5)}  ${title}`;
		})
		.join("\n");
}

/** The constant status-line label while a plan is active. */
const STATUS_LABEL = "Plan";

/** The theme colour tokens the stage glyphs paint with. */
type GlyphToken = "dim" | "warning" | "accent" | "success";

interface Glyph {
	char: string;
	token: GlyphToken;
}

/**
 * A distinct shape and colour per stage. The four active stages
 * fill the circle monotonically — think ○, plan ◑, build ◕,
 * concluded ● — so the lifecycle reads as a progression without
 * colour. Retired ⊘ and idle ◌ leave the fill ramp because they
 * are not points along it.
 */
const STAGE: Record<Stage, Glyph> = {
	idle: { char: "\u25cc", token: "dim" }, // ◌
	think: { char: "\u25cb", token: "warning" }, // ○
	plan: { char: "\u25d1", token: "warning" }, // ◑
	build: { char: "\u25d5", token: "accent" }, // ◕
	concluded: { char: "\u25cf", token: "success" }, // ●
	retired: { char: "\u2298", token: "dim" }, // ⊘
};

/** Status-line indicator: a glyph and a steady "Plan" label, or nothing at idle. */
export function renderStatus(stage: Stage, theme: Theme): string | undefined {
	if (stage === "idle") return undefined;
	const { char, token } = STAGE[stage];
	return `${theme.fg(token, char)} ${theme.fg("muted", STATUS_LABEL)}`;
}

/** The five-step fill ramp the progress meter climbs, empty to full. */
const FILL = ["\u25cb", "\u25d4", "\u25d1", "\u25d5", "\u25cf"]; // ○ ◔ ◑ ◕ ●

/**
 * The progress meter glyph for a checkbox ratio, in quarter
 * buckets: empty at none done, then a quarter, a half and a
 * three-quarter fill, and the full circle only once every box is
 * checked. With no checkboxes the meter is empty. The full
 * circle turns success-green; every partial state stays accent
 * so the meter reads as "building" until it completes.
 */
function progressGlyph(done: number, total: number): Glyph {
	if (total <= 0 || done <= 0) return { char: FILL[0], token: "accent" };
	if (done >= total) return { char: FILL[4], token: "success" };
	const ratio = done / total;
	const bucket = ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : 3;
	return { char: FILL[bucket], token: "accent" };
}

/**
 * The progress text for the widget: a 1-based step position
 * while work remains (the step you're on, `done + 1`), and the
 * honest full count once every box is checked. Empty when there
 * are no checkboxes.
 */
function progressText(done: number, total: number): string {
	if (total <= 0) return "";
	const step = done >= total ? total : done + 1;
	return ` \u00b7 ${step}/${total}`;
}

/** What the widget needs to paint a line. */
export interface WidgetInput {
	stage: Stage;
	title: string | null;
	done: number;
	total: number;
}

/**
 * Widget line: a completion-filled progress glyph, then the
 * stage, the step position and the title, truncated to width so
 * the line never wraps.
 */
export function renderWidget(
	input: WidgetInput,
	theme: Theme,
	width: number,
): string[] {
	const { char, token } = progressGlyph(input.done, input.total);
	const colouredGlyph = theme.fg(token, char);
	const label = `${input.stage}${progressText(input.done, input.total)}`;
	const prefix = `${colouredGlyph} ${theme.fg("muted", label)}`;
	if (!input.title) return [truncateToWidth(prefix, width)];
	const room = Math.max(0, width - GLYPH_COLS - (label.length + 1));
	const line = `${prefix} ${theme.fg("dim", truncateToWidth(input.title, room))}`;
	return [truncateToWidth(line, width)];
}
