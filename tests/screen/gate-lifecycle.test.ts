/**
 * A docked gate across everything that ends or replaces what it belongs to.
 *
 * `/new`, `/fork`, `/tree`, `/reload`, `/quit` and Ctrl+D each tear down a
 * turn, a session or the whole process in their own order, and a gate that
 * waits for its person through one of them is a gate that hangs the
 * command, runs what it guards, or leaves its record in a transcript about
 * to be rebuilt without it. So each is run here with a gate up, raised by a
 * tool, by a guardian and by a command, and beside progress, on real pi.
 *
 * What counts as clean is judged against a twin: the same session with a
 * plain widget of the gate's height in its place and nothing of ours. Pi
 * leaves blank rows of its own when a screen that overflows loses rows,
 * and a plain pi that does not overflow cannot show them, so the gate is
 * held to what pi itself does with the same screen, not to zero. The twin
 * stands at the height the gate is when the act commits: a gate gives rows
 * back to a selector opened below it, and pi's renderer leaves a shrink's
 * blank rows or clears them depending on exactly where its viewport top
 * falls, so one row of difference can swing the count by fourteen.
 *
 * Which guard carries which case, found by switching each off: a replace
 * or a stop rests on the turn's signal alone, since pi waits for the turn
 * to go idle before the session ends; a quit or an idle reload is ended
 * by any one of the signal, the dock noticing its widget taken away, and
 * the lifecycle closing every panel at shutdown.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import panelLifecycle from "../../extensions/panel-lifecycle-workflow/index.ts";
import { ALLOW, registerGuardian } from "../../lib/guardian/index.ts";
import { dock } from "../../lib/ui/dock.ts";
import { GATE_ARM_MS } from "../../lib/ui/gate-dock.ts";
import { dockRows } from "../../lib/ui/pi-layout.ts";
import { showSinglePrompt } from "../../lib/ui/prompt-single.ts";
import { bootPi, type PiSession, sleep, waitFor } from "./pi-session.ts";

const TITLE = "MARK-title Approve the thing?";
const CANCELLED = "\u2717 cancelled";

vi.setConfig({ testTimeout: 60_000 });

/** What each gate answered, in order. */
let answers: unknown[];
/** The session a scenario is running, for the tools to measure. */
let current: PiSession | undefined;
/** Rows docked around the editor just before our widget went up. */
let beforeWidget = 0;
/** Where the guarded command leaves its mark if it ever runs. */
let scratch: string;

/** Notes the rows docked now, before our widget adds its own. */
function measureBefore(): void {
	if (current) beforeWidget = dockRows(current.tui, current.term.columns);
}

/** Asks the gate every raiser here asks, answering with its result. */
async function ask(ctx: ExtensionContext): Promise<unknown> {
	measureBefore();
	const result = await showSinglePrompt(ctx, {
		title: TITLE,
		content: (_theme, width) =>
			Array.from({ length: 4 }, (_, i) =>
				`MARK-body-${i} ${"lorem ipsum ".repeat(6)}`.slice(0, width),
			),
		actions: [{ key: "r", label: "Reject" }],
	});
	answers.push(result);
	return result;
}

/** A tool that raises the gate. */
function gateTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_gate",
		label: "Ask Gate",
		description: "Raises a gate.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const said = await ask(ctx);
			return {
				content: [
					{ type: "text", text: `MARK-result ${JSON.stringify(said)}` },
				],
				details: {},
			};
		},
	});
}

/** A guardian over any bash command that names the mark, gated by `ask`. */
function guardian(pi: ExtensionAPI): void {
	registerGuardian(pi, {
		detect: (command) => command.includes("MARK-guard"),
		parse: (command) => command,
		async review(_command, ctx) {
			const said = await ask(ctx);
			const approved =
				typeof said === "object" &&
				said !== null &&
				Reflect.get(said, "key") === "__enter__";
			return approved ? ALLOW : { block: true, reason: "MARK-blocked" };
		},
	});
}

/** A command that raises the gate outside any turn. */
function gateCommand(pi: ExtensionAPI): void {
	pi.registerCommand("ask-gate", {
		description: "Raises a gate.",
		handler: async (_args, ctx) => {
			await ask(ctx);
		},
	});
	// The twin's: a plain widget of that many rows, which pi's reset clears.
	pi.registerCommand("twin-widget", {
		description: "Shows a plain widget.",
		handler: async (args, ctx) => {
			const rows = Number(args.trim());
			ctx.ui.setWidget("zz-twin", () => twinWidget(rows));
		},
	});
}

function twinWidget(rows: number): Component {
	return {
		render: () => Array.from({ length: rows }, (_, i) => `MARK-twin-${i}`),
		invalidate() {},
	};
}

/** A tool that docks a progress board and runs until its turn stops. */
function progressTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "progress",
		label: "Progress",
		description: "Shows progress until stopped.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			measureBefore();
			const board = dock(ctx, "test.progress", {
				render: () => Array.from({ length: 5 }, (_, i) => `MARK-progress-${i}`),
				handleInput: () => true,
			});
			await untilAborted(signal);
			board.close();
			return { content: [{ type: "text", text: "stopped" }], details: {} };
		},
	});
}

/**
 * The twin's tool: another extension's plain widget of `rows` rows, up
 * while it runs and gone when its turn stops, standing where the gate was.
 */
function twinTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "twin",
		label: "Twin",
		description: "Shows a plain widget until stopped.",
		parameters: Type.Object({ rows: Type.Number() }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			ctx.ui.setWidget("zz-twin", () => twinWidget(params.rows));
			await untilAborted(signal);
			ctx.ui.setWidget("zz-twin", undefined);
			return { content: [{ type: "text", text: "stopped" }], details: {} };
		},
	});
	// Gone when the session ends, as ours is: the panel lifecycle closes every
	// panel there. Left to its abort alone, the twin left a moment later, and
	// in some runs that folded the frame between the two sessions into the
	// new one's redraw, so the twin came in under what pi paints and ours,
	// which paints it every time, read as worse.
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget("zz-twin", undefined);
	});
}

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!signal || signal.aborted) return resolve();
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

const EXTENSIONS = [
	gateTool,
	guardian,
	gateCommand,
	progressTool,
	twinTool,
	panelLifecycle,
];

beforeEach(() => {
	answers = [];
	beforeWidget = 0;
	scratch = mkdtempSync(join(tmpdir(), "gate-lifecycle-"));
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	const session = current;
	current = undefined;
	await session?.stop();
	rmSync(scratch, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/** The screen a scenario runs on, and how much transcript is above. */
interface Screen {
	readonly cols: number;
	readonly rows: number;
	/** Turns of history, enough to overflow the screen or not. */
	readonly history: number;
}

/** What puts something above the editor for a scenario to tear down. */
type Raiser = "tool" | "guardian" | "progress" | { twin: number };

/** Where the guarded command writes, so running it leaves a file. */
function guardedFile(): string {
	return join(scratch, "ran");
}

/** Boots pi on `screen` with its history laid down. */
async function boot(screen: Screen): Promise<PiSession> {
	const session = await bootPi({
		cols: screen.cols,
		rows: screen.rows,
		extensions: EXTENSIONS,
	});
	current = session;
	for (let turn = 0; turn < screen.history; turn++) {
		session.answer(`MARK-history-${turn} ${"lorem ipsum ".repeat(12)}`);
		await session.prompt(`question ${turn}`);
		await waitFor(
			() => !session.runtime.session.isStreaming,
			`history turn ${turn}`,
		);
	}
	return session;
}

/** Runs a turn whose only call puts `raiser`'s widget up, and waits for it. */
async function raise(session: PiSession, raiser: Raiser): Promise<void> {
	const call =
		raiser === "tool"
			? fauxToolCall("ask_gate", {})
			: raiser === "guardian"
				? fauxToolCall("bash", {
						command: `echo MARK-guard > ${guardedFile()}`,
					})
				: raiser === "progress"
					? fauxToolCall("progress", {})
					: fauxToolCall("twin", { rows: raiser.twin });
	session.faux.setResponses([
		fauxAssistantMessage(call),
		fauxAssistantMessage("MARK-after"),
		fauxAssistantMessage("MARK-extra"),
	]);
	session.mark("raise");
	await session.prompt("raise it");
	const shows =
		raiser === "tool" || raiser === "guardian"
			? TITLE
			: raiser === "progress"
				? "MARK-progress-0"
				: "MARK-twin-0";
	await waitFor(() => session.onScreen(shows), "the widget to show");
	if (raiser === "tool" || raiser === "guardian") {
		await waitFor(() => !session.editorFocused(), "the gate to take focus");
		await sleep(GATE_ARM_MS + 50);
	} else await sleep(150);
}

/** Rows our widget on screen takes, against the frame before it. */
function widgetRows(session: PiSession): number {
	return dockRows(session.tui, session.term.columns) - beforeWidget;
}

/** Rows the gate itself draws now, found by its title; 0 if it is not up. */
function gateLength(session: PiSession): number {
	const width = session.term.columns;
	const search = (parts: readonly unknown[]): number => {
		for (const part of parts) {
			const children = Reflect.get(Object(part), "children");
			if (Array.isArray(children)) {
				const found = search(children);
				if (found > 0) return found;
				continue;
			}
			const render = Reflect.get(Object(part), "render");
			if (typeof render !== "function") continue;
			const lines: unknown = render.call(part, width);
			if (
				Array.isArray(lines) &&
				lines.some((line) => String(line).includes("MARK-title"))
			)
				return lines.length;
		}
		return 0;
	};
	return search(session.tui.children.slice(1));
}

/**
 * The height the twin stands at: our widget's rows when it went up, less
 * whatever the gate has since given back to a selector below it. The gate
 * yields room, a plain widget does not, and pi's renderer leaves blank
 * rows or not depending on exactly where the viewport top falls, so the
 * twin has to be the height ours is at the moment that matters.
 */
let twinRows = 0;
/** What the gate drew when it went up, to measure what it gave back. */
let gateAtRaise = 0;

/** Notes the gate's height now, as the moment an act commits from. */
function commitsNow(session: PiSession, ours: boolean): void {
	if (!ours) return;
	const now = gateLength(session);
	if (now > 0) twinRows -= gateAtRaise - now;
}

/** Types a slash command into the editor and sends it. */
async function command(session: PiSession, text: string): Promise<void> {
	session.mark(text);
	await session.type(text);
	await session.key("enter");
}

/** What a scenario left behind, judged. */
interface Outcome {
	readonly blankMax: number;
	readonly blankAt: string;
	readonly frames: number;
	readonly desync: readonly string[];
	readonly hygiene: readonly string[];
}

async function outcome(session: PiSession): Promise<Outcome> {
	const { blankMax, blankAt, frames, desync, hygiene } =
		await session.verdict();
	return { blankMax, blankAt, frames, desync, hygiene };
}

/** Holds a scenario of ours to its twin's blank rows, and to no desync. */
function expectNoWorseThan(ours: Outcome, twin: Outcome): void {
	expect(ours.desync).toEqual([]);
	expect(ours.hygiene).toEqual([]);
	expect(ours.blankMax).toBeLessThanOrEqual(twin.blankMax);
}

const SCREENS: readonly Screen[] = [
	{ cols: 60, rows: 16, history: 1 },
	{ cols: 60, rows: 16, history: 6 },
	{ cols: 100, rows: 30, history: 1 },
	{ cols: 100, rows: 30, history: 6 },
];

const named = (screen: Screen) =>
	`${screen.cols}x${screen.rows}, ${screen.history} turns`;

/**
 * Something the person does to pi, taken over our widget and then over its
 * twin. It returns once what it started is over; `ours` says which run.
 */
type Act = (session: PiSession, ours: boolean) => Promise<void>;

/** Hops out of a gate to the editor, as a person must to type there. */
async function hopOut(session: PiSession, raiser: Raiser): Promise<void> {
	if (raiser !== "tool" && raiser !== "guardian") return;
	await session.key("ctrl+alt+n");
	expect(session.editorFocused()).toBe(true);
}

/**
 * How many times a twin may run before its worst stands as what pi does.
 * A replace paints the frame between a widget leaving and the new session
 * in most runs and folds it into the next full redraw in others, so one
 * twin can come in under pi's own blank rows. Rerun only while ours shows
 * more: rows pi never leaves are rows no rerun can reach.
 *
 * Which way it goes is pi's render throttle against the replace's
 * immediate redraw, so a busy machine folds more often. Measured on a new
 * session from code, one try in ten folded when idle, and three tries
 * all folded about once in five runs of the whole screen suite. Ten
 * leaves that out of reach, and costs nothing when the first try paints.
 */
const TWIN_TRIES = 10;

/**
 * Runs `act` over `raiser` on `screen`, gives the session to `check` while
 * it is still up, then runs the same over a twin of the same height.
 */
async function judged(
	screen: Screen,
	raiser: "tool" | "guardian" | "progress",
	act: Act,
	check: (session: PiSession) => Promise<void> = async () => {},
): Promise<{ ours: Outcome; twin: Outcome }> {
	const session = await boot(screen);
	await raise(session, raiser);
	twinRows = widgetRows(session);
	gateAtRaise = gateLength(session);
	await hopOut(session, raiser);
	await act(session, true);
	await sleep(150);
	const ours = await outcome(session);
	await check(session);
	await session.stop();
	current = undefined;

	let twin = await twinOf(screen, act);
	for (let tries = 1; tries < TWIN_TRIES; tries++) {
		if (twin.blankMax >= ours.blankMax) break;
		const again = await twinOf(screen, act);
		if (again.blankMax > twin.blankMax) twin = again;
	}
	return { ours, twin };
}

/** One run of `act` over a twin of the height `judged` measured. */
async function twinOf(screen: Screen, act: Act): Promise<Outcome> {
	const session = await boot(screen);
	await raise(session, { twin: twinRows });
	await act(session, false);
	await sleep(150);
	const twin = await outcome(session);
	await session.stop();
	current = undefined;
	return twin;
}

/** `/new` typed into the editor. */
const newTyped: Act = async (session) => {
	await command(session, "/new");
	await waitFor(
		() => session.onScreen("New session started"),
		"the new session",
	);
};

/** A new session asked for from code, as a quest switch does. */
const newFromCode: Act = async (session) => {
	session.mark("newSession");
	await session.runtime.newSession();
};

/** Escape in the editor, which stops the turn. */
const escapeInEditor: Act = async (session) => {
	session.mark("escape");
	await session.key("escape");
	await waitFor(() => !session.runtime.session.isStreaming, "the turn to stop");
};

/** `/fork` from the last message, which replaces the session. */
const fork: Act = async (session, ours) => {
	await command(session, "/fork");
	await sleep(100);
	commitsNow(session, ours);
	await session.key("enter");
	await waitFor(() => session.onScreen("Forked to new session"), "the fork");
};

/** `/fork` opened and then cancelled. */
const forkCancelled: Act = async (session) => {
	await command(session, "/fork");
	await sleep(100);
	await session.key("escape");
	await sleep(100);
};

/** `/tree` to an earlier point without a summary, which stops the turn. */
const tree: Act = async (session, ours) => {
	await command(session, "/tree");
	await sleep(100);
	await session.key("up");
	await session.key("up");
	await session.key("enter");
	await sleep(100);
	commitsNow(session, ours);
	await session.key("enter");
	await waitFor(
		() => session.onScreen("Navigated to selected point"),
		"the navigation",
	);
};

/** `/tree` opened and then cancelled. */
const treeCancelled: Act = async (session) => {
	await command(session, "/tree");
	await sleep(100);
	await session.key("escape");
	await sleep(100);
};

/** `/reload` while the turn runs, which pi refuses. */
const reloadBusy: Act = async (session) => {
	await command(session, "/reload");
	await waitFor(
		() => session.onScreen("Wait for the current response"),
		"pi to refuse the reload",
	);
};

/** Checks the gate left by a replace wrote no record at all. */
async function leftNoRecord(session: PiSession): Promise<void> {
	expect(answers).toEqual([null]);
	// Never written, not merely scrolled or cleared away.
	expect(session.term.writes.join("")).not.toContain(CANCELLED);
	await editorTakesTyping(session);
}

async function editorTakesTyping(session: PiSession): Promise<void> {
	session.mark("typing");
	await session.type("x");
	expect(session.editorFocused()).toBe(true);
	expect(session.editorText()).toContain("x");
}

/** Checks the gate is still waiting, and that a hop and Enter answer it. */
async function stillAnswerable(session: PiSession): Promise<void> {
	expect(answers).toEqual([]);
	await session.key("ctrl+alt+n");
	expect(session.editorFocused()).toBe(false);
	await session.key("enter");
	await waitFor(() => answers.length === 1, "the gate to answer");
	expect(answers).toEqual([{ type: "action", key: "__enter__" }]);
	await waitFor(() => session.onScreen("MARK-after"), "the turn to go on");
	expect(session.editorFocused()).toBe(true);
}

describe.each(
	SCREENS.map((screen) => [named(screen), screen] as const),
)("on %s", (_name, screen) => {
	it("fails closed on /new typed after hopping out of a tool's gate", async () => {
		const { ours, twin } = await judged(screen, "tool", newTyped, leftNoRecord);
		expectNoWorseThan(ours, twin);
	});

	it("fails closed on /new typed after hopping out of a guardian, running nothing", async () => {
		const { ours, twin } = await judged(
			screen,
			"guardian",
			newTyped,
			leftNoRecord,
		);
		expect(existsSync(guardedFile())).toBe(false);
		expectNoWorseThan(ours, twin);
	});

	it("fails closed on a new session from code, the gate still focused", async () => {
		const { ours, twin } = await judged(
			screen,
			"tool",
			async (session, isOurs) => {
				// Back into the gate, so the replace finds it holding the keys.
				if (isOurs) await session.key("ctrl+alt+n");
				await newFromCode(session, isOurs);
			},
			leftNoRecord,
		);
		expectNoWorseThan(ours, twin);
	});

	it("takes progress down with a /new, leaving nothing of ours", async () => {
		const { ours, twin } = await judged(
			screen,
			"progress",
			newTyped,
			async (session) => {
				expect(await session.onScreen("MARK-progress")).toBe(false);
				await editorTakesTyping(session);
			},
		);
		expectNoWorseThan(ours, twin);
	});

	it("fails closed on Escape after hopping out, leaving its record", async () => {
		const { ours, twin } = await judged(
			screen,
			"tool",
			escapeInEditor,
			async (session) => {
				expect(answers).toEqual([null]);
				expect(await session.inBuffer(CANCELLED)).toBe(1);
				await editorTakesTyping(session);
			},
		);
		expectNoWorseThan(ours, twin);
	});

	it("fails closed on /fork, leaving no record in the session it left", async () => {
		const { ours, twin } = await judged(screen, "tool", fork, leftNoRecord);
		expectNoWorseThan(ours, twin);
	});

	it("stays answerable when /fork is cancelled", async () => {
		const { ours, twin } = await judged(
			screen,
			"tool",
			forkCancelled,
			stillAnswerable,
		);
		expectNoWorseThan(ours, twin);
	});

	it("fails closed on /tree to an earlier point", async () => {
		const { ours, twin } = await judged(
			screen,
			"tool",
			tree,
			async (session) => {
				expect(answers).toEqual([null]);
				// Pi rebuilds the transcript from the branch it moved to, which
				// holds no record, and its full redraw clears the scrollback.
				expect(await session.inBuffer(CANCELLED)).toBe(0);
				await editorTakesTyping(session);
			},
		);
		expectNoWorseThan(ours, twin);
	});

	it("stays answerable when /tree is cancelled", async () => {
		const { ours, twin } = await judged(
			screen,
			"tool",
			treeCancelled,
			stillAnswerable,
		);
		expectNoWorseThan(ours, twin);
	});

	it("stays answerable when pi refuses /reload mid-turn", async () => {
		const { ours, twin } = await judged(
			screen,
			"tool",
			reloadBusy,
			stillAnswerable,
		);
		expectNoWorseThan(ours, twin);
	});
});

const QUIT_SCREEN: Screen = { cols: 100, rows: 30, history: 1 };

describe.each([
	["/quit", (session: PiSession) => command(session, "/quit")],
	["Ctrl+D", (session: PiSession) => session.key("ctrl+d")],
] as const)("quitting with %s", (_name, quit) => {
	it.each([
		"tool",
		"guardian",
		"progress",
	] as const)("exits over a %s, and the gate fails closed", async (raiser) => {
		const session = await boot(QUIT_SCREEN);
		await raise(session, raiser);
		await hopOut(session, raiser);

		await quit(session);
		await waitFor(() => session.exits().length > 0, "pi to exit");
		await sleep(100);

		expect(session.exits()).toEqual([0]);
		expect(answers).toEqual(raiser === "progress" ? [] : [null]);
		expect(existsSync(guardedFile())).toBe(false);
	});
});

describe("the guarded command", () => {
	// The control for every case above that says it never ran.
	it("runs once its gate is approved", async () => {
		const session = await boot(QUIT_SCREEN);
		await raise(session, "guardian");

		await session.key("enter");
		await waitFor(() => existsSync(guardedFile()), "the command to run");

		expect(answers).toEqual([{ type: "action", key: "__enter__" }]);
	});
});

describe("a gate a command raised", () => {
	it("fails closed on an idle /reload, and the reloaded command asks again", async () => {
		const session = await boot(QUIT_SCREEN);
		await command(session, "/ask-gate");
		await waitFor(() => session.onScreen(TITLE), "the gate");
		await waitFor(() => !session.editorFocused(), "the gate to take focus");
		const rows = widgetRows(session);
		await session.key("ctrl+alt+n");

		await command(session, "/reload");
		await waitFor(() => answers.length === 1, "the gate to answer");
		await waitFor(() => session.onScreen("Reloaded keybindings"), "the reload");
		await sleep(150);
		const ours = await outcome(session);
		await leftNoRecord(session);

		await session.key("backspace");
		await command(session, "/ask-gate");
		await waitFor(() => session.onScreen(TITLE), "the gate again");
		await session.stop();
		current = undefined;

		const twin = await boot(QUIT_SCREEN);
		await command(twin, `/twin-widget ${rows}`);
		await waitFor(() => twin.onScreen("MARK-twin-0"), "the twin's widget");
		await command(twin, "/reload");
		await waitFor(() => twin.onScreen("Reloaded keybindings"), "the reload");
		await sleep(150);
		expectNoWorseThan(ours, await outcome(twin));
	});
});
