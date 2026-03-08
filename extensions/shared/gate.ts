/**
 * Gate — shared dialog component for user decisions.
 *
 * Follows the ask tool's visual language: accent borders,
 * numbered options, arrow-key navigation. Every gate includes
 * a "Steer" option that opens an inline editor pre-filled
 * with context for free-form feedback.
 *
 * Content that exceeds the terminal height is scrollable via
 * Page Up / Page Down (or j/k when options aren't focused).
 */

import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import {
	type ExtensionContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";

// ---- Types ----

export interface GateOption {
	label: string;
	value: string;
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

// ---- Constants ----

/**
 * Lines reserved for pi chrome (header, footer, status line,
 * input area). Conservative estimate to avoid overflow.
 */
const PI_CHROME_LINES = 6;

/**
 * Lines used by the gate's own frame: top border, bottom
 * border, options, hint line, and spacing.
 */
const GATE_FRAME_LINES = 7;

// ---- Helpers ----

function selectOption(opt: GateOption, steerContext: string | undefined): GateResult | "enter-steer" {
	if (opt.value === "steer") return "enter-steer";
	return { value: opt.value };
}

function buildEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

function renderOptions(
	options: GateOption[],
	selected: number,
	theme: Theme,
): string[] {
	return options.map((opt, i) => {
		const active = i === selected;
		const prefix = active ? theme.fg("accent", "> ") : "  ";
		const color = active ? "accent" : "text";
		return prefix + theme.fg(color, `${i + 1}. ${opt.label}`);
	});
}

function renderSteer(
	editor: Editor,
	width: number,
	theme: Theme,
): string[] {
	const lines: string[] = [""];
	for (const line of editor.render(width - 4)) {
		lines.push(` ┃ ${line}`);
	}
	lines.push("");
	lines.push(theme.fg("dim", " Enter submit · Esc back"));
	return lines;
}

/** Available terminal height for the gate's content area. */
function contentBudget(): number {
	const termRows = process.stdout.rows || 40;
	return Math.max(5, termRows - PI_CHROME_LINES - GATE_FRAME_LINES);
}

// ---- Component ----

export async function showGate(
	ctx: ExtensionContext,
	config: GateConfig,
): Promise<GateResult | null> {
	if (!ctx.hasUI) return null;

	const options = [...config.options, { label: "Steer", value: "steer" }];

	return ctx.ui.custom<GateResult | null>((tui, theme, _kb, done) => {
		let selected = 0;
		let steerMode = false;
		let scrollOffset = 0;
		const editor = new Editor(tui, buildEditorTheme(theme));

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				steerMode = false;
				editor.setText("");
				tui.requestRender();
				return;
			}
			done({ value: "steer", feedback: trimmed });
		};

		function clampScroll(contentLength: number) {
			const budget = contentBudget();
			const maxScroll = Math.max(0, contentLength - budget);
			scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
		}

		function handleInput(data: string) {
			if (steerMode) {
				if (matchesKey(data, Key.escape)) {
					steerMode = false;
					editor.setText("");
					tui.requestRender();
					return;
				}
				editor.handleInput(data);
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.escape)) {
				done(null);
				return;
			}

			// Scroll controls
			if (matchesKey(data, "pageup") || matchesKey(data, "shift+up")) {
				scrollOffset = Math.max(0, scrollOffset - contentBudget());
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "pagedown") || matchesKey(data, "shift+down")) {
				scrollOffset += contentBudget();
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.up)) {
				selected = Math.max(0, selected - 1);
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.down)) {
				selected = Math.min(options.length - 1, selected + 1);
				tui.requestRender();
				return;
			}

			// Number keys select directly
			const num = parseInt(data, 10);
			if (num >= 1 && num <= options.length) {
				selected = num - 1;
			} else if (!matchesKey(data, Key.enter)) {
				return;
			}

			// Confirm selection
			const result = selectOption(options[selected], config.steerContext);
			if (result === "enter-steer") {
				steerMode = true;
				editor.setText(config.steerContext ?? "");
				tui.requestRender();
			} else {
				done(result);
			}
		}

		function render(width: number): string[] {
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("accent", "─".repeat(width)));

			// Build content lines
			const contentLines = config.content(theme, width);
			const budget = contentBudget();
			const needsScroll = contentLines.length > budget;

			// Clamp scroll offset
			clampScroll(contentLines.length);

			if (needsScroll) {
				// Viewport into content
				const visible = contentLines.slice(
					scrollOffset,
					scrollOffset + budget,
				);
				for (const line of visible) {
					add(line);
				}

				// Scroll indicator
				const atTop = scrollOffset === 0;
				const atBottom =
					scrollOffset + budget >= contentLines.length;
				const position = Math.round(
					(scrollOffset / (contentLines.length - budget)) * 100,
				);
				const indicator = atTop
					? "▼ Shift+↓ or PgDn to scroll"
					: atBottom
						? "▲ Shift+↑ or PgUp to scroll"
						: `▲▼ ${position}% · Shift+↑↓ or PgUp/PgDn to scroll`;
				add(theme.fg("dim", ` ${indicator}`));
			} else {
				for (const line of contentLines) {
					add(line);
				}
			}

			if (steerMode) {
				for (const line of renderSteer(editor, width, theme)) {
					add(line);
				}
			} else {
				lines.push("");
				for (const line of renderOptions(options, selected, theme)) {
					add(line);
				}
				lines.push("");
				const scrollHint = needsScroll
					? " · Shift+↑↓ scroll"
					: "";
				add(
					theme.fg(
						"dim",
						` ↑↓ select · Enter confirm · Esc cancel${scrollHint}`,
					),
				);
			}

			add(theme.fg("accent", "─".repeat(width)));
			return lines;
		}

		return { render, handleInput };
	});
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
