/**
 * What an extension puts on the footer is a mark: a glyph, and a short
 * number only when it tells the person something, never words. Joel,
 * 11 November 2026: "the mesh being quiet puts way too much text in the
 * status bar, same for token budgets." Each status is drawn here through
 * its own code at the most it could ever say, and held to six columns
 * with no letters; a new place that sets a status has to be added here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { statusText } from "../../extensions/away-workflow/lifecycle.ts";
import { overridesMark } from "../../extensions/guard-policy-workflow/render.ts";
import { statusLine } from "../../extensions/job-workflow/lifecycle.ts";
import { quietStatus } from "../../extensions/mesh-workflow/quiet.ts";
import { budgetMark } from "../../extensions/spend-workflow/budget.ts";
import type { Allowance } from "../../lib/internal/spend-watch-budgets.ts";
import {
	FOOTER_GLYPH,
	footerMark,
	footerShare,
} from "../../lib/ui/footer-mark.ts";

const ROOT = join(import.meta.dirname, "../..");

/** The most a status may take, in columns: a mark, a space, four more. */
const WIDEST = 6;

/** The largest count a status is drawn with here. */
const MOST = 999;

const plain = { fg: (_colour: string, text: string) => text };

/** A budget's allowance spent past all of it. */
const spent: Allowance = {
	name: "five hours",
	label: "5 h",
	unit: "share",
	used: 3.12,
	state: "refused",
};

/** Every status the package sets, drawn at the most it could say. */
const drawn: Record<string, string | undefined> = {
	away: statusText(
		{ since: 0, held: Array.from({ length: MOST }, () => ({})) } as never,
		plain,
	),
	guards: overridesMark(
		Object.fromEntries(Array.from({ length: MOST }, (_, n) => [n, "off"])),
		plain,
	),
	jobs: statusLine(
		{
			list: () =>
				Array.from({ length: MOST }, () => ({ state: "running" })) as never,
		},
		plain,
	),
	quiet: quietStatus(MOST, plain),
	budget: (() => {
		const mark = budgetMark({
			name: "delta",
			chosen: true,
			allowances: [spent],
		});
		return mark && footerShare("budget", mark.tone, plain, mark.percent);
	})(),
	retrying: footerMark("retrying", "warning", plain, MOST),
	swapped: footerMark("swapped", "muted", plain),
	// verification-workflow draws its cross and attempts as "✕ 3/3".
	failed: `${footerMark("failed", "error", plain)} 3/3`,
};

/**
 * The files that set a status, and the entry above that draws it. The
 * quest's own line and a tabbed prompt's progress only ever clear theirs.
 */
const SETTERS: Record<string, readonly string[]> = {
	"extensions/away-workflow/index.ts": ["away"],
	"extensions/guard-policy-workflow/lifecycle.ts": ["guards"],
	"extensions/job-workflow/lifecycle.ts": ["jobs"],
	"extensions/mesh-workflow/index.ts": ["quiet"],
	"extensions/model-retry-workflow/retry.ts": ["retrying"],
	"extensions/quest-workflow/index.ts": [],
	"extensions/reload-workflow/lifecycle.ts": ["swapped"],
	"extensions/spend-workflow/budget-item.ts": ["budget"],
	"extensions/verification-workflow/index.ts": ["failed"],
	"lib/ui/prompt-tabbed.ts": [],
};

function sources(dir: string): string[] {
	return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(
		(entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return sources(path);
			return entry.name.endsWith(".ts") ? [path] : [];
		},
	);
}

describe("the footer's statuses", () => {
	it.each(Object.entries(drawn))("%s is a mark", (_name, status) => {
		expect(status, "drawn at its most").toBeDefined();
		const text = status ?? "";
		expect({ text, columns: visibleWidth(text) }).toEqual({
			text: text.replace(/[A-Za-z]/g, ""),
			columns: Math.min(visibleWidth(text), WIDEST),
		});
	});

	it("draws each from the one table of marks", () => {
		const glyphs = new Set<string>(Object.values(FOOTER_GLYPH));
		const firsts = Object.values(drawn).map((one) => [...(one ?? "")][0]);
		expect(firsts.filter((glyph) => !glyph || !glyphs.has(glyph))).toEqual(
			[],
		);
	});

	it("knows every place that sets a status", () => {
		const setting = ["extensions", "lib", "host", "packs"]
			.flatMap(sources)
			.filter((path) =>
				/\.setStatus\(/.test(readFileSync(join(ROOT, path), "utf8")),
			)
			.map((path) => relative(ROOT, join(ROOT, path)))
			.sort();
		expect(setting).toEqual(Object.keys(SETTERS).sort());
	});
});
