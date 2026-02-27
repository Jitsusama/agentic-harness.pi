/**
 * Gate — shared dialog component for user decisions.
 *
 * Follows the ask tool's visual language: accent borders,
 * numbered options, arrow-key navigation. Every gate includes
 * a "Steer" option that opens an inline editor pre-filled
 * with context for free-form feedback.
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

			for (const line of config.content(theme, width)) {
				add(line);
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
				add(theme.fg("dim", " ↑↓ select · Enter confirm · Esc cancel"));
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
