/**
 * Gate — shared dialog component for user decisions.
 *
 * Follows the ask tool's visual language: accent borders,
 * numbered options, arrow-key navigation. Every gate includes
 * a "Steer" option that opens an inline editor pre-filled
 * with context for free-form feedback.
 *
 * Replaces ctx.ui.select() across all extensions for a
 * consistent look and feel.
 */

import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---- Types ----

export interface GateOption {
	label: string;
	value: string;
}

export interface GateConfig {
	/** Renders the content section. Receives theme and width. */
	content: (
		theme: {
			fg: (color: string, text: string) => string;
			bg: (color: string, text: string) => string;
			bold: (text: string) => string;
		},
		width: number,
	) => string[];
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

// ---- Component ----

export async function showGate(
	ctx: ExtensionContext,
	config: GateConfig,
): Promise<GateResult | null> {
	if (!ctx.hasUI) return null;

	// Build option list — steer always last
	const options = [...config.options];
	const steerIndex = options.length;
	options.push({ label: "Steer", value: "steer" });

	return ctx.ui.custom<GateResult | null>((tui, theme, _kb, done) => {
		let optionIndex = 0;
		let steerMode = false;
		let cachedLines: string[] | undefined;

		// Editor for steer mode
		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		// Steer submission
		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) {
				// Empty feedback — go back to options
				steerMode = false;
				editor.setText("");
				refresh();
				return;
			}
			done({ value: "steer", feedback: trimmed });
		};

		function handleInput(data: string) {
			// Steer mode — route to editor
			if (steerMode) {
				if (matchesKey(data, Key.escape)) {
					steerMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// Option navigation
			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(options.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			// Number keys for direct selection
			const num = parseInt(data, 10);
			if (num >= 1 && num <= options.length) {
				optionIndex = num - 1;
				// Fall through to Enter handling
			} else if (!matchesKey(data, Key.enter)) {
				// Cancel on Escape
				if (matchesKey(data, Key.escape)) {
					done(null);
				}
				return;
			}

			// Select current option
			if (matchesKey(data, Key.enter) || (num >= 1 && num <= options.length)) {
				const opt = options[optionIndex];
				if (opt.value === "steer") {
					steerMode = true;
					editor.setText(config.steerContext ?? "");
					refresh();
					return;
				}
				done({ value: opt.value });
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const add = (s: string) =>
				lines.push(truncateToWidth(s, width));

			// Top border
			add(theme.fg("accent", "─".repeat(width)));

			// Content section
			const contentLines = config.content(theme, width);
			for (const line of contentLines) {
				add(line);
			}

			if (steerMode) {
				// Steer editor
				lines.push("");
				for (const line of editor.render(width - 4)) {
					add(` ┃ ${line}`);
				}
				lines.push("");
				add(
					theme.fg("dim", " Enter submit · Esc back"),
				);
			} else {
				// Options
				lines.push("");
				for (let i = 0; i < options.length; i++) {
					const selected = i === optionIndex;
					const prefix = selected
						? theme.fg("accent", "> ")
						: "  ";
					const color = selected ? "accent" : "text";
					add(
						prefix +
							theme.fg(color, `${i + 1}. ${options[i].label}`),
					);
				}
				lines.push("");
				add(
					theme.fg(
						"dim",
						" ↑↓ select · Enter confirm · Esc cancel",
					),
				);
			}

			// Bottom border
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

// ---- Steer result helper ----

/**
 * Formats a steer result into a block reason for tool_call handlers.
 */
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
