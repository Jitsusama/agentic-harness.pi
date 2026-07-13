import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import {
	type NavigableSection,
	renderNavigableSections,
} from "./navigable-list.js";
import { computeChromeLines } from "./panel-layout.js";
import {
	contentBudget,
	renderScrollRegion,
	SCROLLBAR_GUTTER,
	type ScrollState,
} from "./scroll-region.js";
import { GLYPH } from "./types.js";

/** One toggleable row: a labelled setting that cycles through a fixed set of options. */
export interface ToggleRow {
	id: string;
	label: string;
	options: string[];
	index: number;
	detail?: string;
}

/** A titled group of toggle rows. */
export interface ToggleSection {
	title: string;
	rows: ToggleRow[];
}

/** The settings surface: titled sections of toggle rows. */
export interface ToggleListConfig {
	title: string;
	sections: ToggleSection[];
	hint?: string;
}

/** The live editing state: the sections, the flat selection index and the filter text. */
export interface ToggleListModel {
	sections: ToggleSection[];
	selected: number;
	filter: string;
}

/** Build a fresh model from a config, deep-copying rows so cycling never mutates the caller's config. */
export function initToggleModel(config: ToggleListConfig): ToggleListModel {
	return {
		sections: config.sections.map((section) => ({
			title: section.title,
			rows: section.rows.map((row) => ({ ...row, options: [...row.options] })),
		})),
		selected: 0,
		filter: "",
	};
}

/** The section/row coordinates of every row matching the filter, in flat selection order. */
export function visibleOrder(
	model: ToggleListModel,
): Array<{ section: number; row: number }> {
	const needle = model.filter.toLowerCase();
	const order: Array<{ section: number; row: number }> = [];
	model.sections.forEach((section, s) => {
		section.rows.forEach((row, r) => {
			if (row.label.toLowerCase().includes(needle))
				order.push({ section: s, row: r });
		});
	});
	return order;
}

/** Move the selection by delta, clamped to the visible range. */
export function moveSelection(
	model: ToggleListModel,
	delta: number,
): ToggleListModel {
	const count = visibleOrder(model).length;
	const max = Math.max(0, count - 1);
	return {
		...model,
		selected: Math.min(max, Math.max(0, model.selected + delta)),
	};
}

/** Advance the selected row's value to the next option, wrapping around. */
export function cycleSelected(model: ToggleListModel): ToggleListModel {
	const target = visibleOrder(model)[model.selected];
	if (!target) return model;
	const sections = model.sections.map((section, s) => ({
		title: section.title,
		rows: section.rows.map((row, r) =>
			s === target.section && r === target.row
				? { ...row, index: (row.index + 1) % row.options.length }
				: row,
		),
	}));
	return { ...model, sections };
}

/** Replace the filter text and reset the selection to the top of the new visible set. */
export function setFilter(
	model: ToggleListModel,
	filter: string,
): ToggleListModel {
	return { ...model, filter, selected: 0 };
}

/** The selected value of every row, keyed by row id, regardless of the current filter. */
export function selectedValues(model: ToggleListModel): Record<string, string> {
	const values: Record<string, string> = {};
	for (const section of model.sections) {
		for (const row of section.rows) values[row.id] = row.options[row.index];
	}
	return values;
}

/**
 * Present a settings surface where up/down navigate, Enter cycles the selected
 * row's value, typing filters and Esc clears a non-empty filter or otherwise
 * closes the panel. Returns each row's selected value. Headless callers get the
 * config's initial values unchanged.
 */
export async function promptToggleList(
	ctx: ExtensionContext,
	config: ToggleListConfig,
): Promise<Record<string, string>> {
	const initial = initToggleModel(config);
	if (!ctx.hasUI) return selectedValues(initial);

	return ctx.ui.custom<Record<string, string>>((tui, theme, _kb, done) => {
		let model = initial;
		const scroll: ScrollState = { vOffset: 0, hOffset: 0 };
		const rerender = () => tui.requestRender();

		function handleInput(data: string) {
			if (matchesKey(data, Key.up)) model = moveSelection(model, -1);
			else if (matchesKey(data, Key.down)) model = moveSelection(model, 1);
			else if (matchesKey(data, Key.enter)) model = cycleSelected(model);
			else if (matchesKey(data, Key.escape)) {
				if (model.filter) model = setFilter(model, "");
				else return done(selectedValues(model));
			} else if (matchesKey(data, Key.backspace))
				model = setFilter(model, model.filter.slice(0, -1));
			else if (data.length === 1 && data >= " " && data <= "~")
				model = setFilter(model, model.filter + data);
			else return;
			rerender();
		}

		return {
			handleInput,
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [];
				const add = (line: string) => lines.push(truncateToWidth(line, width));

				add(theme.fg("accent", GLYPH.hrule.repeat(width)));
				add(` ${theme.fg("accent", theme.bold(config.title))}`);
				add("");

				const budget = contentBudget(
					computeChromeLines(false, undefined, undefined) + 4,
				);
				const content = renderNavigableSections(
					toSections(model, theme),
					model.selected,
					theme,
					undefined,
					width - SCROLLBAR_GUTTER,
				);
				followSelection(scroll, content.selectedLine, budget);
				const { lines: scrolled } = renderScrollRegion(
					content.lines,
					scroll,
					budget,
					width,
					theme,
				);
				for (const line of scrolled) add(line);

				add("");
				if (model.filter) add(theme.fg("dim", ` filter: ${model.filter}`));
				const escLabel = model.filter ? "Esc clear filter" : "Esc cancel";
				add(
					theme.fg(
						"dim",
						` ↑↓ select · type to filter · Enter cycle · ${escLabel}`,
					),
				);
				add(theme.fg("accent", GLYPH.hrule.repeat(width)));
				return lines;
			},
		};
	});
}

function toSections(model: ToggleListModel, theme: Theme): NavigableSection[] {
	const needle = model.filter.toLowerCase();
	const out: NavigableSection[] = [];
	for (const section of model.sections) {
		const items = section.rows
			.filter((row) => row.label.toLowerCase().includes(needle))
			.map((row) => ({
				summary: `${row.label}  ${theme.fg("dim", `[${row.options[row.index]}]`)}`,
				subtitle: row.detail ? [row.detail] : undefined,
			}));
		if (items.length > 0) out.push({ heading: section.title, items });
	}
	return out;
}

function followSelection(
	scroll: ScrollState,
	selectedLine: number,
	budget: number,
) {
	if (selectedLine < scroll.vOffset) scroll.vOffset = selectedLine;
	else if (selectedLine >= scroll.vOffset + budget)
		scroll.vOffset = selectedLine - budget + 1;
}
