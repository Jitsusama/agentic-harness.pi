/**
 * What the transcript draws, it draws one way.
 *
 * A tool call is one line: the tool bold, what it was asked to do plain,
 * and what it was pointed at dim (`lib/ui/tool-call.ts`). Browser, review,
 * work and subagents drew that line; twelve other tools drew their own,
 * and nine strayed, with the action dim in one, muted in another and
 * plain in a third, and three periods beside a real ellipsis. The same event in several shapes
 * is what a reader scanning a transcript notices.
 *
 * The accent is where the keys go. A board's selected row has it; a
 * running row painted in it too left the selection told apart only by
 * its cursor once several were running. An answer's question in the
 * accent, and a cancel in the warning colour, broke the same rules from
 * the other side: a cancel is the shared dim mark, as everywhere else.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import advisor from "../../extensions/advisor/index.ts";
import ask from "../../extensions/ask-workflow/index.ts";
import away from "../../extensions/away-workflow/index.ts";
import { renderSections } from "../../extensions/compaction-workflow/status.ts";
import capture from "../../extensions/correction-capture/index.ts";
import { renderGoogleCall } from "../../extensions/google-workspace-integration/render-call.ts";
import reload from "../../extensions/reload-workflow/index.ts";
import { roundBoard } from "../../extensions/review-integration/progress.ts";
import slack from "../../extensions/slack-integration/index.ts";
import { fleetBoard } from "../../extensions/subagent-workflow/progress-render.ts";
import web from "../../extensions/web-search-integration/index.ts";
import { boardLines, fitBoard } from "../../lib/ui/board.ts";
import { fakeTheme } from "../lib/ui/fake-theme.ts";

const theme = fakeTheme();

/** What a tool registers, as far as drawing it goes. */
interface Drawn {
	name: string;
	renderCall: (args: unknown, theme: Theme, context: unknown) => Component;
	renderResult: (
		result: unknown,
		options: unknown,
		theme: Theme,
		context: unknown,
	) => Component;
}

/**
 * Anything pi is asked for that isn't a tool: callable, and with every
 * property the same again, so `pi.events.on(...)` does nothing too. It
 * has no `then`, or awaiting a call's result would wait on it.
 */
const nothing: unknown = new Proxy(() => undefined, {
	get: (_target, key) => (key === "then" ? undefined : nothing),
	apply: () => undefined,
});

/** The tools an extension registers, with everything else it asks pi for ignored. */
async function toolsOf(
	extension: (pi: ExtensionAPI) => unknown,
): Promise<Map<string, Drawn>> {
	const tools = new Map<string, Drawn>();
	const pi = new Proxy(
		{},
		{
			get: (_target, key) =>
				key === "registerTool"
					? (tool: Drawn) => tools.set(tool.name, tool)
					: nothing,
		},
	);
	await extension(pi as ExtensionAPI);
	return tools;
}

/** The one line a component draws, at a width nothing wraps at. */
function shown(component: Component): string {
	return component.render(1000).join("\n").trimEnd();
}

/** The shared line, spelt in the fake theme's markers. */
function callLine(tool: string, action?: string, subject?: string): string {
	const name = `<toolTitle><b>${tool}</b></toolTitle>`;
	const verb = action === undefined ? "" : ` ${action}`;
	const what = subject === undefined ? "" : `<dim> ${subject}</dim>`;
	return `${name}${verb}${what}`;
}

describe("a tool call", () => {
	const cases: ReadonlyArray<{
		extension: (pi: ExtensionAPI) => unknown;
		tool: string;
		args: Record<string, unknown>;
		line: string;
	}> = [
		{
			extension: advisor,
			tool: "advisor",
			args: { action: "enable" },
			line: callLine("advisor", "enable"),
		},
		{
			extension: ask,
			tool: "ask",
			args: { questions: [{ id: "scope", label: "Scope" }] },
			line: callLine("ask", "1 question", "Scope"),
		},
		{
			extension: away,
			tool: "away",
			args: { goal: "work through the plan" },
			line: callLine("away", undefined, "work through the plan"),
		},
		{
			extension: capture,
			tool: "capture_lesson",
			args: { list: true },
			line: callLine("capture_lesson", "list"),
		},
		{
			extension: reload,
			tool: "reload",
			args: { onto: "installed", reason: "take the merge" },
			line: callLine("reload", undefined, "installed"),
		},
		{
			extension: slack,
			tool: "slack",
			args: { action: "upload_file", channel: "general", file_path: "/a" },
			line: callLine("slack", "upload_file", "#general 1 file"),
		},
		{
			extension: web,
			tool: "web_read",
			args: { url: "https://example.com/a/page?x=1" },
			line: callLine("web_read", undefined, "example.com/a/page"),
		},
	];

	for (const { extension, tool, args, line } of cases) {
		it(`is the shared line for ${tool}`, async () => {
			const drawn = (await toolsOf(extension)).get(tool);
			expect(drawn).toBeDefined();
			expect(shown(drawn?.renderCall(args, theme, {}) as Component)).toBe(line);
		});
	}

	it("is the shared line for google, the account a dim note", () => {
		expect(
			shown(
				renderGoogleCall(
					{ action: "get_email", id: "abc", account: "personal" },
					theme,
				),
			),
		).toBe(`${callLine("google", "get_email", "abc")}<dim> [personal]</dim>`);
	});
});

describe("an answer to ask", () => {
	async function answered(details: unknown): Promise<string> {
		const drawn = (await toolsOf(ask)).get("ask");
		return shown(
			drawn?.renderResult(
				{ content: [{ type: "text", text: "" }], details },
				{},
				theme,
				{},
			) as Component,
		);
	}

	it("draws a cancel as the shared dim mark", async () => {
		expect(await answered({ cancelled: true, answers: [] })).toBe(
			"<dim>\u2212 cancelled</dim>",
		);
	});

	it("keeps the accent off the question it answers", async () => {
		const line = await answered({
			cancelled: false,
			answers: [{ id: "scope", label: "Small", index: 1 }],
		});
		expect(line).toBe(
			"<success>\u2713 </success><muted>scope:</muted> 1. Small",
		);
	});
});

describe("a panel's sections", () => {
	it("head each in bold, as the panel's title is, not in the accent", () => {
		const lines = renderSections(
			[{ id: "cycles", order: 0, title: "Cycles", lines: ["one"] }],
			theme,
		);
		expect(lines).toContain("  <toolTitle><b>Cycles</b></toolTitle>");
		expect(lines.join("\n")).not.toContain("<accent>");
	});
});

describe("a board of spawned work", () => {
	it("gives the accent to the selected subagent's row, not to every running one", () => {
		const entry = (id: string) => ({
			spec: { id },
			state: "running" as const,
			warnings: [],
			error: "",
			activity: "",
		});
		const board = fleetBoard([entry("one"), entry("two")], theme, {
			selected: 0,
			notice: "",
		});
		expect(board.rows[0]).toMatch(/^<accent>/);
		// Its name too, not only its cursor: the status inside a row ends its
		// own colour, and a wrap round the whole row ended with it.
		expect(board.rows[0]).toContain("<accent>one");
		expect(board.rows[1]).not.toContain("<accent>");
	});

	it("gives the accent to the selected reviewer's row, not to every running one", () => {
		const entry = (participantId: string) => ({
			participantId,
			state: "running" as const,
			activity: "",
			startedAt: 0,
		});
		const board = roundBoard(
			"council",
			[entry("one"), entry("two")] as never,
			theme,
			{ selected: 0, notice: "", now: 0 },
		);
		expect(board.rows[0]).toMatch(/^<accent>/);
		// Its name too, not only its cursor: the status inside a row ends its
		// own colour, and a wrap round the whole row ended with it.
		expect(board.rows[0]).toContain("<accent>one");
		expect(board.rows[1]).not.toContain("<accent>");
	});

	const entry = (id: string) => ({
		spec: { id },
		state: "running" as const,
		warnings: [],
		error: "",
		activity: "",
	});

	it("holds no accent while the keys are in the editor", () => {
		// With something on the rule's right and without, since the rule
		// fills differently for each. Wide, since the fake theme's markers
		// count as width and would crowd the right out at 80.
		for (const notice of ["", "Ctrl+Alt+N to manage"]) {
			const board = fleetBoard([entry("one"), entry("two")], theme, {
				selected: -1,
				notice,
			});
			const lines = boardLines(board, theme, 400, false);
			expect(lines[0]).toContain(notice);
			expect(lines.join("\n")).not.toContain("<accent>");
			expect(fitBoard(board, theme, 400, false, 2).join("\n")).not.toContain(
				"<accent>",
			);
		}
	});

	it("rules its title in the border colour, as a gate does, focused or not", () => {
		const board = fleetBoard([entry("one")], theme, {
			selected: 0,
			notice: "",
			hop: { presses: 0, next: undefined },
		});
		const [rule] = boardLines(board, theme, 400, true);
		expect(rule).toMatch(/^<border>\u2500\u2500<\/border> /);
		expect(rule).toMatch(/<border>\u2500+<\/border>$/);
		expect(rule).not.toContain("<accent>");
	});

	it("runs its rule unbroken to the edge when nothing on its right is drawn", () => {
		// Coloured as a terminal is, escapes with no width, since an empty
		// aside coloured is the case: the markers would give it width.
		const [red, green, plain, bold, unbold] = [
			"\x1b[31m",
			"\x1b[32m",
			"\x1b[39m",
			"\x1b[1m",
			"\x1b[22m",
		];
		const ansi = {
			fg: (colour: string, text: string) =>
				`${colour === "accent" ? green : red}${text}${plain}`,
			bold: (text: string) => `${bold}${text}${unbold}`,
		} as unknown as Theme;
		const unstyled = (row: string) =>
			[red, green, plain, bold, unbold].reduce(
				(text, code) => text.replaceAll(code, ""),
				row,
			);
		const board = fleetBoard([entry("one")], ansi, {
			selected: 0,
			notice: "",
			hop: { presses: 0, next: undefined },
		});
		const [drawn = ""] = boardLines(board, ansi, 60, true);
		expect(drawn).not.toContain(green);
		const rule = unstyled(drawn);
		expect(rule).toMatch(/done \u2500+$/);
		expect(rule).toHaveLength(60);

		// Too narrow for what's on the right, the rule runs on without it,
		// in the same colour.
		const away = fleetBoard([entry("one")], ansi, {
			selected: -1,
			notice: "Ctrl+Alt+N to manage",
		});
		const [narrow = ""] = boardLines(away, ansi, 35, false);
		expect(narrow).not.toContain(green);
		expect(unstyled(narrow)).toMatch(/done \u2500+$/);
		expect(unstyled(narrow)).toHaveLength(35);
	});
});
