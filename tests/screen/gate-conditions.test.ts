/**
 * A docked gate under the conditions the rest of the screen suite does not
 * raise: pi's own selector opened over it or under it, a steer sent while
 * it waits, the terminal resized under it, and rows that would break the
 * screen if they reached pi as written.
 *
 * Each was run in the lab against a reimplementation; these run the
 * shipped `showSinglePrompt` inside the real InteractiveMode, so what they
 * hold is what ships.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import panelLifecycle from "../../extensions/panel-lifecycle-workflow/index.ts";
import { GATE_ARM_MS, GATE_TYPING_IDLE_MS } from "../../lib/ui/gate-dock.ts";
import { showSinglePrompt } from "../../lib/ui/prompt-single.ts";
import { bootPi, type PiSession, sleep, waitFor } from "./pi-session.ts";

const TITLE = "MARK-title Approve the thing?";
const APPROVED = { type: "action", key: "__enter__" };

vi.setConfig({ testTimeout: 30_000 });

/** What each gate answered, in order. */
let gates: unknown[];
/** What each of pi's selectors answered, in order. */
let picks: (string | undefined)[];
/** Rows the gate's content draws, replaced by a case that needs others. */
let body: (width: number) => string[];
let pi: PiSession | undefined;

function plainBody(width: number): string[] {
	return Array.from({ length: 4 }, (_, i) =>
		`MARK-body-${i} ${"lorem ipsum ".repeat(6)}`.slice(0, width),
	);
}

async function ask(ctx: ExtensionContext): Promise<void> {
	gates.push(
		await showSinglePrompt(ctx, {
			title: TITLE,
			content: (_theme, width) => body(width),
			actions: [{ key: "r", label: "Reject" }],
		}),
	);
}

/** A tool that raises a gate after `delay` ms. */
function gateTool(api: ExtensionAPI): void {
	api.registerTool({
		name: "ask_gate",
		label: "Ask Gate",
		description: "Raises a gate.",
		parameters: Type.Object({ delay: Type.Number() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			await sleep(params.delay);
			await ask(ctx);
			return {
				content: [{ type: "text", text: "MARK-gate-result" }],
				details: {},
			};
		},
	});
}

/** A tool that opens pi's own selector after `delay` ms. */
function pickTool(api: ExtensionAPI): void {
	api.registerTool({
		name: "pick",
		label: "Pick",
		description: "Opens pi's selector.",
		parameters: Type.Object({ delay: Type.Number() }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			await sleep(params.delay);
			picks.push(
				await ctx.ui.select(
					"MARK-select Pick one",
					["MARK-opt-a", "MARK-opt-b"],
					{
						signal,
					},
				),
			);
			return {
				content: [{ type: "text", text: "MARK-pick-result" }],
				details: {},
			};
		},
	});
}

beforeEach(() => {
	gates = [];
	picks = [];
	body = plainBody;
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	await pi?.stop();
	pi = undefined;
	vi.restoreAllMocks();
});

async function boot(cols = 100, rows = 30): Promise<PiSession> {
	const session = await bootPi({
		cols,
		rows,
		extensions: [gateTool, pickTool, panelLifecycle],
	});
	pi = session;
	session.answer(`MARK-history ${"lorem ipsum ".repeat(12)}`);
	await session.prompt("question");
	await waitFor(() => !session.runtime.session.isStreaming, "the history");
	return session;
}

/** Runs a turn whose one message makes `calls` at once. */
async function turn(
	session: PiSession,
	calls: ReturnType<typeof fauxToolCall>[],
): Promise<void> {
	session.faux.setResponses([
		fauxAssistantMessage(calls),
		fauxAssistantMessage("MARK-after"),
		fauxAssistantMessage("MARK-extra"),
	]);
	session.mark("turn");
	await session.prompt("go");
}

/** Waits for the gate to have the keys, and for its arm to pass. */
async function gateHasKeys(session: PiSession): Promise<void> {
	await waitFor(
		async () => (await session.inBuffer("MARK-title")) > 0,
		"the gate",
	);
	await waitFor(() => !session.editorFocused(), "the gate to take focus");
	await sleep(GATE_ARM_MS + 50);
}

async function turnEnds(session: PiSession): Promise<void> {
	await waitFor(() => session.onScreen("MARK-after"), "the turn to go on");
	await waitFor(() => !session.runtime.session.isStreaming, "the turn to end");
	await sleep(100);
}

async function expectClean(session: PiSession): Promise<void> {
	const verdict = await session.verdict();
	expect(verdict.desync).toEqual([]);
	expect(verdict.hygiene).toEqual([]);
}

/** The editor takes typing: the keys ended up where the person can use them. */
async function editorTakesTyping(session: PiSession): Promise<void> {
	await session.type("z");
	expect(session.editorFocused()).toBe(true);
	expect(session.editorText()).toContain("z");
}

describe("pi's selector opened over a gate", () => {
	it("takes the keys, answers, and gives the gate them back", async () => {
		const session = await boot();
		await turn(session, [
			fauxToolCall("ask_gate", { delay: 0 }),
			fauxToolCall("pick", { delay: 1500 }),
		]);
		await gateHasKeys(session);
		await waitFor(() => session.onScreen("MARK-select"), "pi's selector");
		// Read before it is answered, long enough for the gate to want the
		// keys back if it would take them from anything.
		await sleep(GATE_TYPING_IDLE_MS + 300);

		// The selector has the keys, not the gate.
		await session.key("down");
		await session.key("enter");
		await waitFor(() => picks.length === 1, "the selector to answer");
		expect(picks).toEqual(["MARK-opt-b"]);
		expect(gates).toEqual([]);

		await waitFor(
			() => !session.editorFocused(),
			"the gate to take focus back",
		);
		await sleep(GATE_ARM_MS + 50);
		await session.key("enter");
		await turnEnds(session);

		expect(gates).toEqual([APPROVED]);
		await editorTakesTyping(session);
		await expectClean(session);
	});

	it("hops out of the gate to the editor once the selector has gone", async () => {
		const session = await boot();
		await turn(session, [
			fauxToolCall("ask_gate", { delay: 0 }),
			fauxToolCall("pick", { delay: 1500 }),
		]);
		await gateHasKeys(session);
		await waitFor(() => session.onScreen("MARK-select"), "pi's selector");
		await sleep(GATE_TYPING_IDLE_MS + 300);
		await session.key("enter");
		await waitFor(() => picks.length === 1, "the selector to answer");
		await waitFor(
			() => !session.editorFocused(),
			"the gate to take focus back",
		);

		await session.key("ctrl+alt+n");

		expect(session.editorFocused()).toBe(true);
		await session.type("q");
		expect(session.editorText()).toBe("q");
	});
});

describe("a gate raised while pi's selector is open", () => {
	it("leaves the keys with the selector, then takes them once it is answered", async () => {
		const session = await boot();
		await turn(session, [
			fauxToolCall("pick", { delay: 0 }),
			fauxToolCall("ask_gate", { delay: 800 }),
		]);
		await waitFor(() => session.onScreen("MARK-select"), "pi's selector");
		await waitFor(
			async () => (await session.inBuffer("MARK-title")) > 0,
			"the gate",
		);
		await sleep(1200);

		await session.key("down");
		await session.key("enter");
		await waitFor(() => picks.length === 1, "the selector to answer");
		expect(picks).toEqual(["MARK-opt-b"]);
		expect(gates).toEqual([]);

		await waitFor(() => !session.editorFocused(), "the gate to take focus");
		await sleep(GATE_ARM_MS + 50);
		await session.key("enter");
		await turnEnds(session);

		expect(gates).toEqual([APPROVED]);
		await editorTakesTyping(session);
		await expectClean(session);
	});
});

describe("a steer sent while a gate waits", () => {
	it("keeps the gate up and reaches pi after the gate is answered", async () => {
		const session = await boot();
		await turn(session, [fauxToolCall("ask_gate", { delay: 0 })]);
		await gateHasKeys(session);

		await session.key("ctrl+alt+n");
		await session.type("MARK-steer do it the other way");
		await session.key("enter");
		await sleep(300);

		expect(gates).toEqual([]);
		expect(await session.onScreen("MARK-title")).toBe(true);
		expect(session.editorText()).toBe("");

		await session.key("ctrl+alt+n");
		await session.key("enter");
		await turnEnds(session);

		expect(gates).toEqual([APPROVED]);
		// Delivered to the model as the person's own message.
		expect(JSON.stringify(session.runtime.session.messages)).toContain(
			"MARK-steer do it the other way",
		);
		await expectClean(session);
	});
});

describe("a gate across a resize", () => {
	it("stays whole and answerable through a shrink and a grow", async () => {
		const session = await boot();
		await turn(session, [fauxToolCall("ask_gate", { delay: 0 })]);
		await gateHasKeys(session);

		// Shorter than the gate's natural height with pi's editor and footer.
		session.term.resize(60, 12);
		await sleep(200);
		// Folded into the smaller room, with pi's editor and footer below it.
		expect(await session.onScreen("MARK-title")).toBe(true);
		expect((await session.viewport()).at(-1)).toContain("faux-1");
		session.term.resize(120, 40);
		await sleep(200);
		expect(await session.onScreen("MARK-body-3")).toBe(true);

		await session.key("enter");
		await turnEnds(session);

		expect(gates).toEqual([APPROVED]);
		await expectClean(session);
	});
});

describe("rows that would break the screen", () => {
	it("reach pi as rows it can draw", async () => {
		body = (width) => [
			"MARK-newline first\nsecond",
			"MARK-return over\rwritten",
			`MARK-jump left${String.fromCharCode(27)}[40Cright`,
			`MARK-long ${"x".repeat(width * 2)}`,
			"MARK-wide 👨‍👩‍👧‍👦 ▷ 漢字",
		];
		const session = await boot(60, 20);
		await turn(session, [fauxToolCall("ask_gate", { delay: 0 })]);
		await gateHasKeys(session);

		await expectClean(session);
		await session.key("enter");
		await turnEnds(session);
		await expectClean(session);
	});
});
