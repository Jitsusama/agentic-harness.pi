import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	guardsCompletions,
	parseGuardsCommand,
} from "../../../extensions/guard-policy-workflow/command.ts";
import {
	GUARD_MODES_ENTRY,
	savedModesOf,
} from "../../../extensions/guard-policy-workflow/lifecycle.ts";
import {
	COLLAPSED_BODY_LINES,
	guardReportLines,
	guardTableLines,
} from "../../../extensions/guard-policy-workflow/render.ts";
import type { ResolvedGuard } from "../../../lib/guardian/index.ts";
import { plainTheme } from "../../lib/ui/fake-theme.ts";

const KEYS = ["all", "approval", "commit", "git", "history"];

describe("/guards arguments", () => {
	it("lists with no arguments and resets on reset", () => {
		expect(parseGuardsCommand("  ", KEYS)).toEqual({ kind: "list" });
		expect(parseGuardsCommand("reset", KEYS)).toEqual({ kind: "reset" });
	});

	it("sets a known key to a mode", () => {
		expect(parseGuardsCommand("git block", KEYS)).toEqual({
			kind: "set",
			key: "git",
			mode: "block",
		});
	});

	it("refuses a key nothing reads, naming the ones that exist", () => {
		const parsed = parseGuardsCommand("gti block", KEYS);
		expect(parsed.kind).toBe("error");
		expect(parsed.kind === "error" && parsed.message).toContain("commit");
	});

	it("refuses a mode that is not one", () => {
		const parsed = parseGuardsCommand("git loud", KEYS);
		expect(parsed.kind === "error" && parsed.message).toContain(
			"off, redirect, block",
		);
	});

	it("completes whole argument strings, since a completion replaces them", () => {
		expect(guardsCompletions("", KEYS)).toContain("reset");
		expect(guardsCompletions("gi", KEYS)).toEqual(["git"]);
		expect(guardsCompletions("git r", KEYS)).toEqual(["git redirect"]);
		expect(guardsCompletions("git ", KEYS)).toEqual([
			"git off",
			"git redirect",
			"git block",
		]);
	});

	it("reads the old report mode as off", () => {
		expect(parseGuardsCommand("git report", KEYS)).toEqual({
			kind: "set",
			key: "git",
			mode: "off",
		});
	});
});

describe("saved session overrides", () => {
	const entry = (data: unknown) => ({
		type: "custom",
		customType: GUARD_MODES_ENTRY,
		data,
	});

	it("reads the newest saved entry on the branch", () => {
		const modes = savedModesOf([
			entry({ modes: { git: "block" } }),
			{ type: "message" },
			entry({ modes: { commit: "off" } }),
		]);
		expect(modes).toEqual({ commit: "off" });
	});

	it("drops a mode it does not know and a malformed entry", () => {
		expect(
			savedModesOf([entry({ modes: { git: "loud", pr: "off" } })]),
		).toEqual({ pr: "off" });
		expect(savedModesOf([entry("nonsense")])).toEqual({});
		expect(savedModesOf([])).toEqual({});
	});
});

describe("a guard report in the transcript", () => {
	const theme = plainTheme();
	const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n");

	it("names the guard and what it did", () => {
		const [header] = guardReportLines(
			{ guard: "commit", kind: "shown", title: "Commit" },
			theme,
			80,
			false,
		);
		expect(header).toContain("commit guard");
		expect(header).toContain("reported: Commit");
	});

	it("collapses a long body and says how much is left", () => {
		const lines = guardReportLines(
			{ guard: "pr", kind: "shown", title: "PR", body: long },
			theme,
			80,
			false,
		);
		expect(lines.length).toBe(COLLAPSED_BODY_LINES + 2);
		expect(lines.at(-1)).toMatch(/\d+ more lines/);
	});

	it("shows all of it expanded, and the notes after", () => {
		const lines = guardReportLines(
			{
				guard: "commit",
				kind: "shown",
				title: "Commit",
				body: long,
				notes: ["✓ wrap", "✓ conventional"],
			},
			theme,
			80,
			true,
		);
		expect(lines.join("\n")).toContain("line 29");
		expect(lines.at(-1)).toContain("✓ wrap");
		expect(lines.join("\n")).not.toMatch(/more lines/);
	});

	it("never draws past the width", () => {
		const lines = guardReportLines(
			{
				guard: "history-destructive",
				kind: "waved",
				title: "x".repeat(200),
				body: "y ".repeat(200),
				notes: ["z".repeat(200)],
			},
			theme,
			40,
			true,
		);
		for (const line of lines)
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});
});

describe("the guard table", () => {
	const theme = plainTheme();
	const guard = (name: string, mode: ResolvedGuard["mode"]): ResolvedGuard => ({
		declaration: {
			name,
			class: "approval",
			description: `What ${name} asks about.`,
			defaultMode: "redirect",
		},
		mode,
		source: "default",
	});

	it("draws a row per guard with its mode, source and last outcome", () => {
		const lines = guardTableLines(
			[guard("commit", "redirect"), guard("slack", "block")],
			new Map([["commit", { kind: "allowed" as const }]]),
			theme,
			100,
		);
		const commit = lines.find((l) => l.trimStart().startsWith("commit"));
		expect(commit).toMatch(/approval\s+redirect\s+default\s+last: allowed/);
		expect(lines.join("\n")).toContain("What slack asks about.");
		expect(lines.join("\n")).toContain("/guards reset");
	});

	it("says so when nothing is declared", () => {
		expect(guardTableLines([], new Map(), theme, 80).join("")).toContain(
			"No guards declared",
		);
	});

	it("never draws past the width", () => {
		const lines = guardTableLines(
			[guard("quest-untracked-tree", "redirect")],
			new Map(),
			theme,
			30,
		);
		for (const line of lines)
			expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});
});
