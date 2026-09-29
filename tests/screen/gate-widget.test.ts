/**
 * A gate raised by a tool, in real pi: docked above an editor that stays
 * on screen, holding the keyboard with a hop out to the editor and back.
 *
 * The complaint this answers: a gate was an overlay drawn over the
 * transcript and the editor, holding every key until it was answered, so
 * nobody could type a steer or read what they were being asked about in
 * context. The gate now docks above the editor as a widget. It takes the
 * keyboard once it has been painted and the person has stopped typing, so a
 * key meant for the draft never answers it; the hop chord moves between it
 * and the editor; and when it is answered it settles into the transcript as
 * its own record, in the frame it leaves, so nothing jumps and no blank row
 * is left behind.
 *
 * The primitives under test are the real `showSinglePrompt` and
 * `showTabbedPrompt`, raised from a tool inside the real InteractiveMode.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import panelLifecycle from "../../extensions/panel-lifecycle-workflow/index.ts";
import { dock } from "../../lib/ui/dock.ts";
import { GATE_ARM_MS, GATE_TYPING_IDLE_MS } from "../../lib/ui/gate-dock.ts";
import { showSinglePrompt } from "../../lib/ui/prompt-single.ts";
import { showTabbedPrompt } from "../../lib/ui/prompt-tabbed.ts";
import { bootPi, type PiSession, sleep, strip, waitFor } from "./pi-session.ts";

const TITLE = "MARK-title Approve the thing?";

// A turn or three of history, a gate and its arm take longer than the
// default allows on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });

/** What each gate answered, in order. */
let answers: unknown[];
let pi: PiSession | undefined;

/** A tool that raises a gate and answers with what the gate said. */
function gateTool(api: ExtensionAPI): void {
	api.registerTool({
		name: "ask_gate",
		label: "Ask Gate",
		description: "Raises a gate.",
		parameters: Type.Object({
			kind: Type.Optional(Type.String()),
			lines: Type.Optional(Type.Number()),
			tag: Type.Optional(Type.String()),
			delayMs: Type.Optional(Type.Number()),
			/** Lines in a tabbed gate's second item, when not `lines`. */
			second: Type.Optional(Type.Number()),
			/** Rows of a progress widget docked before the gate, if any. */
			progress: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const progress = params.progress ?? 0;
			const board =
				progress > 0
					? dock(ctx, "test.progress", {
							render: () =>
								Array.from(
									{ length: progress },
									(_, i) => `MARK-progress-${i}`,
								),
							handleInput: () => true,
						})
					: undefined;
			await sleep(params.delayMs ?? 0);
			const lines = params.lines ?? 4;
			const content = (_theme: unknown, width: number) =>
				Array.from({ length: lines }, (_, i) =>
					`MARK-body${params.tag ?? ""}-${i} ${"lorem ipsum ".repeat(6)}`.slice(
						0,
						width,
					),
				);
			const result =
				params.kind === "tabbed"
					? await showTabbedPrompt(ctx, {
							title: TITLE,
							items: [
								{
									label: "First",
									views: [{ key: "o", label: "Overview", content }],
								},
								{
									label: "Second",
									views: [
										{
											key: "o",
											label: "Overview",
											content: (theme: unknown, width: number) =>
												content(theme, width).slice(0, params.second ?? lines),
										},
									],
								},
							],
							actions: [{ key: "r", label: "Reject" }],
							autoResolve: true,
						})
					: await showSinglePrompt(ctx, {
							title: `${TITLE}${params.tag ?? ""}`,
							content,
							actions: [{ key: "r", label: "Reject" }],
						});
			const said =
				result && "items" in result
					? { items: [...result.items.values()] }
					: result;
			answers.push(said);
			board?.close();
			return {
				content: [
					{ type: "text", text: `MARK-result ${JSON.stringify(said)}` },
				],
				details: {},
			};
		},
	});
}

beforeEach(() => {
	answers = [];
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	await pi?.stop();
	pi = undefined;
	vi.restoreAllMocks();
});

interface RaiseOptions {
	readonly cols?: number;
	readonly rows?: number;
	readonly history?: number;
	readonly kind?: "single" | "tabbed";
	readonly lines?: number;
	/** Gates raised by one message, each tagged by its index. */
	readonly gates?: number;
	/** Lines in a tabbed gate's second item. */
	readonly second?: number;
	/** Rows of a progress widget docked before the gate. */
	readonly progress?: number;
}

/** Boots pi, runs a turn whose tool raises a gate, and waits for it. */
async function raise(options: RaiseOptions = {}): Promise<PiSession> {
	const session = await bootPi({
		cols: options.cols ?? 100,
		rows: options.rows ?? 30,
		extensions: [gateTool, panelLifecycle],
	});
	pi = session;
	for (let turn = 0; turn < (options.history ?? 0); turn++) {
		session.answer(`MARK-history-${turn} ${"lorem ipsum ".repeat(12)}`);
		await session.prompt(`question ${turn}`);
		await waitFor(
			() => !session.runtime.session.isStreaming,
			`history turn ${turn}`,
		);
	}
	const calls = Array.from({ length: options.gates ?? 1 }, (_, i) =>
		fauxToolCall("ask_gate", {
			kind: options.kind ?? "single",
			lines: options.lines ?? 4,
			tag: (options.gates ?? 1) > 1 ? String(i) : "",
			second: options.second ?? options.lines ?? 4,
			progress: options.progress ?? 0,
		}),
	);
	session.faux.setResponses([
		fauxAssistantMessage(calls),
		fauxAssistantMessage("MARK-after-the-gate"),
	]);
	session.mark("gate");
	await session.prompt("raise it");
	await waitFor(
		async () => (await session.inBuffer("MARK-title")) > 0,
		"the gate",
	);
	return session;
}

/** Waits for the gate to take the keyboard, then for its arm to pass. */
async function armed(session: PiSession): Promise<void> {
	await waitFor(() => !session.editorFocused(), "the gate to take focus");
	await sleep(GATE_ARM_MS + 50);
}

/** Whether pi has any overlay up, hidden or shown. */
function overlaid(session: PiSession): unknown {
	return Reflect.get(session.tui, "hasOverlayEntries");
}

async function turnEnds(session: PiSession): Promise<void> {
	await waitFor(
		() => session.onScreen("MARK-after-the-gate"),
		"the turn to carry on past the gate",
	);
	await waitFor(() => !session.runtime.session.isStreaming, "the turn to end");
	await sleep(50);
}

async function expectClean(session: PiSession): Promise<void> {
	const verdict = await session.verdict();
	expect(verdict.desync).toEqual([]);
	expect(verdict.hygiene).toEqual([]);
	expect(verdict.blankMax).toBe(0);
	expect(verdict.redrawsAt).toEqual([]);
}

describe("a gate raised by a tool", () => {
	it("docks above the editor rather than covering it", async () => {
		const session = await raise();

		expect(overlaid(session)).toBe(false);
		expect(await session.onScreen(TITLE)).toBe(true);
		expect(await session.onScreen("MARK-body-0")).toBe(true);
	});

	it("takes the keyboard once it is on screen", async () => {
		const session = await raise();

		await waitFor(() => !session.editorFocused(), "the gate to take focus");
		expect(await session.onScreen(TITLE)).toBe(true);
	});

	it("has been drawn by the time it takes the keyboard", async () => {
		const session = await bootPi({
			cols: 100,
			rows: 30,
			extensions: [gateTool, panelLifecycle],
		});
		pi = session;
		// Whether the gate's title had been written to the terminal at each
		// moment the keyboard moved somewhere new.
		const drawnWhenTaken: boolean[] = [];
		const setFocus = session.tui.setFocus.bind(session.tui);
		session.tui.setFocus = (component) => {
			if (component !== null && component !== session.focused())
				drawnWhenTaken.push(session.term.writes.join("").includes(TITLE));
			setFocus(component);
		};
		session.faux.setResponses([
			fauxAssistantMessage([
				// After the typing gap, so nothing but the paint holds it back.
				fauxToolCall("ask_gate", {
					kind: "single",
					lines: 4,
					tag: "",
					delayMs: GATE_TYPING_IDLE_MS + 100,
				}),
			]),
			fauxAssistantMessage("MARK-after-the-gate"),
		]);
		await session.prompt("raise it");

		await waitFor(() => !session.editorFocused(), "the gate to take focus");
		expect(drawnWhenTaken).toEqual([true]);
	});

	it("says how to reach the editor", async () => {
		const session = await raise();
		await waitFor(() => !session.editorFocused(), "the gate to take focus");

		expect(await session.onScreen("Ctrl+Alt+N")).toBe(true);
	});

	it("approves on Enter and settles into the transcript without a blank row", async () => {
		const session = await raise({ history: 3 });
		await armed(session);

		session.mark("answer");
		await session.key("enter");
		await turnEnds(session);

		expect(answers).toEqual([{ type: "action", key: "__enter__" }]);
		expect(await session.inBuffer("✓ approved")).toBe(1);
		expect(session.editorFocused()).toBe(true);
		await expectClean(session);
	});

	it("fails closed on Escape, leaving a record that says so", async () => {
		const session = await raise({ history: 3 });
		await armed(session);

		await session.key("escape");
		await turnEnds(session);

		expect(answers).toEqual([null]);
		expect(await session.inBuffer("✗ cancelled")).toBe(1);
		expect(session.editorFocused()).toBe(true);
		await expectClean(session);
	});

	it("says a rejection is one", async () => {
		const session = await raise();
		await armed(session);

		await session.key("r");
		await turnEnds(session);

		expect(answers).toEqual([{ type: "action", key: "r" }]);
		expect(await session.inBuffer("✗ rejected")).toBe(1);
	});
});

describe("a gate arriving while the person types", () => {
	it("leaves every key with the draft until the typing stops", async () => {
		const session = await bootPi({
			extensions: [gateTool, panelLifecycle],
		});
		pi = session;
		session.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ask_gate", {})),
			fauxAssistantMessage("MARK-after-the-gate"),
		]);
		await session.prompt("raise it");

		const typed = "a steer typed through the gate";
		let seenWhileTyping = false;
		for (const character of typed) {
			await session.type(character);
			if (await session.onScreen("MARK-title")) seenWhileTyping = true;
			expect(session.editorFocused()).toBe(true);
			await sleep(60);
		}
		const stopped = Date.now();

		expect(seenWhileTyping).toBe(true);
		expect(session.editorText()).toBe(typed);
		await waitFor(() => !session.editorFocused(), "the gate to take focus");
		expect(Date.now() - stopped).toBeGreaterThanOrEqual(
			GATE_TYPING_IDLE_MS - 100,
		);
	});

	it("ignores an Enter that lands the moment it takes the keyboard", async () => {
		const session = await raise();
		await waitFor(() => !session.editorFocused(), "the gate to take focus");

		await session.key("enter");
		await sleep(100);

		expect(answers).toEqual([]);
		expect(await session.onScreen(TITLE)).toBe(true);
		await sleep(GATE_ARM_MS);
		await session.key("enter");
		await turnEnds(session);
		expect(answers).toEqual([{ type: "action", key: "__enter__" }]);
	});
});

describe("the hop chord on a gate", () => {
	it("moves to the editor and back, keeping a steer typed meanwhile", async () => {
		const session = await raise();
		await waitFor(() => !session.editorFocused(), "the gate to take focus");

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(true);
		await session.type("a steer");
		expect(await session.onScreen("a steer")).toBe(true);
		expect(await session.onScreen(TITLE)).toBe(true);

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("enter");
		await waitFor(() => answers.length === 1, "the gate to answer");

		expect(answers).toEqual([{ type: "action", key: "__enter__" }]);
		expect(session.editorText()).toBe("a steer");
	});

	it("reaches the gate before a progress widget already docked", async () => {
		const session = await raise({ progress: 20 });
		await armed(session);

		// The gate is dealt its rows first, so it is whole and the board gives.
		expect(await session.onScreen("MARK-body-3")).toBe(true);
		expect(await session.onScreen("MARK-progress-19")).toBe(false);

		// Gate, then the progress widget, then the editor, then the gate.
		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(true);
		await session.key("ctrl+alt+n");
		await session.key("enter");
		await waitFor(() => answers.length === 1, "the gate to answer");

		expect(answers).toEqual([{ type: "action", key: "__enter__" }]);
	});

	it("does not take the keyboard back once the person left it", async () => {
		const session = await raise();
		await waitFor(() => !session.editorFocused(), "the gate to take focus");

		await session.key("ctrl+alt+n");
		await sleep(GATE_TYPING_IDLE_MS + GATE_ARM_MS + 200);

		expect(session.editorFocused()).toBe(true);
		expect(await session.onScreen(TITLE)).toBe(true);
	});

	it("passes Ctrl+C through to pi, which clears the draft", async () => {
		const session = await raise();
		await waitFor(() => !session.editorFocused(), "the gate to take focus");
		await session.key("ctrl+alt+n");
		await session.type("a draft");
		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);

		await session.key("ctrl+c");

		expect(session.editorText()).toBe("");
		expect(answers).toEqual([]);
	});
});

describe("a gate closed from outside", () => {
	it("fails closed when its turn is stopped", async () => {
		const session = await raise();
		await waitFor(() => !session.editorFocused(), "the gate to take focus");
		await session.key("ctrl+alt+n");

		await session.key("escape");
		await waitFor(() => answers.length === 1, "the gate to answer");
		await waitFor(
			() => !session.runtime.session.isStreaming,
			"the turn to stop",
		);
		await sleep(50);

		expect(answers).toEqual([null]);
		expect(await session.onScreen(TITLE)).toBe(false);
		expect(session.editorFocused()).toBe(true);
		const verdict = await session.verdict();
		expect(verdict.desync).toEqual([]);
		expect(verdict.blankMax).toBe(0);
	});

	it("leaves no record when its session is replaced", async () => {
		const session = await raise();
		await waitFor(() => !session.editorFocused(), "the gate to take focus");

		await session.runtime.newSession();
		await waitFor(() => answers.length === 1, "the gate to answer");
		await sleep(100);

		expect(answers).toEqual([null]);
		// Never written, not merely scrolled or cleared away.
		expect(session.term.writes.join("")).not.toContain("✗ cancelled");
		await session.type("x");
		expect(session.editorText()).toBe("x");
	});
});

describe("gates one after another", () => {
	it("shows each in turn and leaves a record of each", async () => {
		const session = await raise({ gates: 2, history: 2 });
		await armed(session);

		await session.key("enter");
		await waitFor(() => answers.length === 1, "the first gate to answer");
		await waitFor(
			async () => (await session.inBuffer(`${TITLE}1`)) > 0,
			"the second gate",
		);
		await armed(session);
		await session.key("escape");
		await turnEnds(session);

		expect(answers).toEqual([{ type: "action", key: "__enter__" }, null]);
		expect(await session.inBuffer("✓ approved")).toBe(1);
		expect(await session.inBuffer("✗ cancelled")).toBe(1);
		await expectClean(session);
	});
});

describe("a tabbed gate", () => {
	it("answers each item and settles once, cleanly", async () => {
		const session = await raise({ kind: "tabbed", history: 2 });
		await armed(session);

		await session.key("enter");
		await session.key("enter");
		await turnEnds(session);

		expect(answers).toEqual([
			{
				items: [
					{ type: "action", key: "__enter__" },
					{ type: "action", key: "__enter__" },
				],
			},
		]);
		expect(await session.inBuffer("✓ answered 2 of 2")).toBe(1);
		await expectClean(session);
	});
});

describe("a gate that gets shorter", () => {
	it("holds its height rather than leave rows blank under the editor", async () => {
		const session = await raise({
			kind: "tabbed",
			lines: 10,
			second: 1,
			history: 3,
		});
		await armed(session);

		await session.key("enter");
		await waitFor(
			async () => !(await session.onScreen("MARK-body-9")),
			"the shorter item",
		);
		await sleep(50);
		expect((await session.verdict()).blankMax).toBe(0);

		await session.key("enter");
		await turnEnds(session);
		await expectClean(session);
	});
});

describe("a gate taller than a small terminal", () => {
	for (const kind of ["single", "tabbed"] as const) {
		it(`fits the ${kind} gate without redrawing the transcript`, async () => {
			const session = await raise({
				kind,
				cols: 60,
				rows: 16,
				lines: 20,
				history: 3,
			});
			await armed(session);

			const shown = (await session.viewport()).map(strip);
			expect(shown.some((row) => row.includes("Ctrl+Alt+N"))).toBe(true);
			await session.key("escape");
			await turnEnds(session);

			expect(answers).toEqual([null]);
			await expectClean(session);
		});
	}
});
