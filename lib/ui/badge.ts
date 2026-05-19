/**
 * Compact inline indicators for severity, agreement, status
 * and progress. Each badge renders to a short themed string
 * that composes inside summary lines, status fragments and
 * narration.
 *
 * Badges are intentionally tiny: a glyph plus optional text,
 * themed to a semantic colour. They're meant to be embedded
 * in larger compositions, not to stand alone.
 *
 * Two flavours:
 *   - `renderBadge`: single-token indicator (dot, fraction, label)
 *   - `renderBar`: visual fraction as a filled/empty character bar
 */

import type { Theme } from "@mariozechner/pi-coding-agent";

/** Semantic kinds. Each maps to a glyph and theme colour. */
export type BadgeKind =
	| "critical"
	| "warning"
	| "info"
	| "ok"
	| "muted"
	| "running"
	| "pending"
	| "skipped"
	| "rejected";

/** Mapping of badge kind to glyph and colour. */
const BADGE_STYLE: Record<BadgeKind, { glyph: string; color: string }> = {
	critical: { glyph: "●", color: "error" },
	warning: { glyph: "●", color: "warning" },
	info: { glyph: "●", color: "accent" },
	ok: { glyph: "●", color: "success" },
	muted: { glyph: "·", color: "dim" },
	running: { glyph: "◈", color: "accent" },
	pending: { glyph: "◇", color: "muted" },
	skipped: { glyph: "·", color: "dim" },
	rejected: { glyph: "✕", color: "error" },
};

/** Options for `renderBadge`. */
export interface BadgeOptions {
	/** Optional text shown after the glyph. */
	label?: string;
	/** Override the default glyph for the kind. */
	glyph?: string;
}

/**
 * Render a compact indicator: themed glyph and optional label.
 *
 * Examples:
 *   renderBadge("critical", theme)                  → ●
 *   renderBadge("ok", theme, { label: "5/7" })      → ● 5/7
 *   renderBadge("running", theme, { label: "R1" })  → ◈ R1
 */
export function renderBadge(
	kind: BadgeKind,
	theme: Theme,
	options?: BadgeOptions,
): string {
	const style = BADGE_STYLE[kind];
	const glyph = options?.glyph ?? style.glyph;
	const label = options?.label;
	const colored = theme.fg(style.color, label ? `${glyph} ${label}` : glyph);
	return colored;
}

/** Options for `renderBar`. */
export interface BarOptions {
	/** Total bar width in characters. Default: 7. */
	width?: number;
	/** Theme colour applied to the bar. Default: "success". */
	color?: string;
	/** Hide the trailing `numerator/denominator` text. Default: false. */
	hideFraction?: boolean;
}

/**
 * Render a visual fraction as a filled/empty bar.
 *
 * Example:
 *   renderBar(6, 7, theme)                    → ▰▰▰▰▰▰▱ 6/7
 *   renderBar(3, 5, theme, { hideFraction })  → ▰▰▰▱▱
 *
 * The numerator clamps to `[0, denominator]`; out-of-range
 * inputs render to the nearest valid bar.
 */
export function renderBar(
	numerator: number,
	denominator: number,
	theme: Theme,
	options?: BarOptions,
): string {
	const width = options?.width ?? 7;
	const color = options?.color ?? "success";
	const clamped = Math.max(0, Math.min(denominator, numerator));
	const ratio = denominator > 0 ? clamped / denominator : 0;
	const filledCount = Math.round(ratio * width);
	const filled = "▰".repeat(filledCount);
	const empty = "▱".repeat(width - filledCount);

	const bar = theme.fg(color, filled) + theme.fg("dim", empty);
	if (options?.hideFraction) return bar;
	return `${bar} ${theme.fg("dim", `${clamped}/${denominator}`)}`;
}
