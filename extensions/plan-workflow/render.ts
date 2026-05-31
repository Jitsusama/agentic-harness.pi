/**
 * The scoreboard's two surfaces. The status line stays steady: a
 * constant "Plan" label beside a glyph that carries the stage
 * through its shape and colour, so the line never shifts from
 * stage to stage. The widget spells out the detail: the stage,
 * the checkbox progress and the plan's title. Both fall silent
 * at idle. These produce strings only; lifecycle owns the
 * setStatus and setWidget calls.
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

/** A distinct shape and colour per stage, so the board reads without colour. */
const STAGE: Record<Stage, Glyph> = {
	idle: { char: "\u25cc", token: "dim" }, // ◌
	think: { char: "\u25cb", token: "warning" }, // ○
	plan: { char: "\u25d0", token: "warning" }, // ◐
	build: { char: "\u25cf", token: "accent" }, // ●
	concluded: { char: "\u2713", token: "success" }, // ✓
	retired: { char: "\u2298", token: "dim" }, // ⊘
};

/** Status-line indicator: a glyph and a steady "Plan" label, or nothing at idle. */
export function renderStatus(stage: Stage, theme: Theme): string | undefined {
	if (stage === "idle") return undefined;
	const { char, token } = STAGE[stage];
	return `${theme.fg(token, char)} ${theme.fg("muted", STATUS_LABEL)}`;
}

/** What the widget needs to paint a line. */
export interface WidgetInput {
	stage: Stage;
	title: string | null;
	done: number;
	total: number;
}

/** Widget line: the glyph, the stage, the progress and the title. */
export function renderWidget(
	input: WidgetInput,
	theme: Theme,
	width: number,
): string[] {
	const { char, token } = STAGE[input.stage];
	const colouredGlyph = theme.fg(token, char);
	const progress = input.total > 0 ? ` \u00b7${input.done}/${input.total}` : "";
	const label = `${input.stage}${progress}`;
	const prefix = `${colouredGlyph} ${theme.fg("muted", label)}`;
	if (!input.title) return [prefix];
	const room = Math.max(0, width - GLYPH_COLS - (label.length + 1));
	return [`${prefix} ${theme.fg("dim", truncateToWidth(input.title, room))}`];
}
