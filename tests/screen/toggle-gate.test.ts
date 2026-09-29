/**
 * A toggle list raised by a tool, in real pi: docked above an editor that
 * stays on screen, like any other gate.
 *
 * The complaint this answers: a tool that asks for settings (the tool
 * gateway's configure call does) raised the list as an overlay over the
 * transcript and the editor, holding every key until it was answered, so
 * nobody could type a steer or read what they were being asked about.
 * A settings list is a question waiting on its person, so it docks as a
 * gate does: it takes the keyboard once painted and once the person has
 * stopped typing, the hop chord moves between it and the editor, and once
 * answered it settles into the transcript as a record without leaving a
 * blank row.
 *
 * The primitive under test is the real `promptToggleList`, raised from a
 * tool inside the real InteractiveMode.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import panelLifecycle from "../../extensions/panel-lifecycle-workflow/index.ts";
import { GATE_ARM_MS } from "../../lib/ui/gate-dock.ts";
import { promptToggleList } from "../../lib/ui/prompt-toggle-list.ts";
import { bootPi, type PiSession, sleep, waitFor } from "./pi-session.ts";

const TITLE = "MARK-toggle Configure the thing";

// A turn or three of history, a gate and its arm take longer than the
// default allows on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });

/** What each list answered, in order. */
let answers: Record<string, string>[];
let pi: PiSession | undefined;

/** The values a list of `rows` rows opens with: every row on. */
function opening(rows: number): Record<string, string> {
	return Object.fromEntries(
		Array.from({ length: rows }, (_, i) => [`row-${i}`, "on"]),
	);
}

/** A tool that raises a toggle list and answers with what it returned. */
function toggleTool(api: ExtensionAPI): void {
	api.registerTool({
		name: "toggle_gate",
		label: "Toggle Gate",
		description: "Raises a toggle list.",
		parameters: Type.Object({ rows: Type.Number() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const values = await promptToggleList(ctx, {
				title: TITLE,
				sections: [
					{
						title: "MARK-section",
						rows: Array.from({ length: params.rows }, (_, i) => ({
							id: `row-${i}`,
							label: `MARK-row-${i}`,
							options: ["on", "off"],
							index: 0,
						})),
					},
				],
			});
			answers.push(values);
			return {
				content: [
					{ type: "text", text: `MARK-result ${JSON.stringify(values)}` },
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
	readonly kitty?: boolean;
	readonly rows?: number;
	readonly history?: number;
	readonly listRows?: number;
}

/** Boots pi, runs a turn whose tool raises a toggle list, and waits for it. */
async function raise(options: RaiseOptions = {}): Promise<PiSession> {
	const session = await bootPi({
		cols: 100,
		rows: options.rows ?? 30,
		kitty: options.kitty ?? true,
		extensions: [toggleTool, panelLifecycle],
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
	session.faux.setResponses([
		fauxAssistantMessage([
			fauxToolCall("toggle_gate", { rows: options.listRows ?? 3 }),
		]),
		fauxAssistantMessage("MARK-after-the-gate"),
	]);
	session.mark("gate");
	await session.prompt("raise it");
	await waitFor(
		async () => (await session.inBuffer("MARK-toggle")) > 0,
		"the list",
	);
	return session;
}

/** Waits for the list to take the keyboard, then for its arm to pass. */
async function armed(session: PiSession): Promise<void> {
	await waitFor(() => !session.editorFocused(), "the list to take focus");
	await sleep(GATE_ARM_MS + 50);
}

/** Whether pi has any overlay up, hidden or shown. */
function overlaid(session: PiSession): unknown {
	return Reflect.get(session.tui, "hasOverlayEntries");
}

async function turnEnds(session: PiSession): Promise<void> {
	await waitFor(
		() => session.onScreen("MARK-after-the-gate"),
		"the turn to carry on past the list",
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

describe("a toggle list raised by a tool", () => {
	it("docks above the editor rather than covering it", async () => {
		const session = await raise();

		expect(overlaid(session)).toBe(false);
		expect(await session.onScreen(TITLE)).toBe(true);
		expect(await session.onScreen("MARK-row-2")).toBe(true);
	});

	it("says the way out to the editor while it has the keys", async () => {
		const session = await raise();
		await waitFor(() => !session.editorFocused(), "the list to take focus");

		expect(await session.onScreen("Ctrl+Alt+N editor")).toBe(true);
	});

	it("submits what was cycled and settles into the transcript without a blank row", async () => {
		const session = await raise({ history: 3 });
		await armed(session);

		await session.key("enter");
		session.mark("answer");
		await session.key("ctrl+enter");
		await turnEnds(session);

		expect(answers).toEqual([{ ...opening(3), "row-0": "off" }]);
		expect(await session.inBuffer("✓ 1 changed")).toBe(1);
		// A record takes no keys, so it offers none.
		expect(await session.inBuffer("Enter cycle")).toBe(0);
		expect(session.editorFocused()).toBe(true);
		await expectClean(session);
	});

	it("fails closed on Escape with the values it opened with", async () => {
		const session = await raise({ history: 3 });
		await armed(session);

		await session.key("enter");
		await session.key("escape");
		await turnEnds(session);

		expect(answers).toEqual([opening(3)]);
		expect(await session.inBuffer("✗ nothing changed")).toBe(1);
		expect(session.editorFocused()).toBe(true);
		await expectClean(session);
	});

	it("hops out to the editor and back with the draft kept", async () => {
		const session = await raise();
		await armed(session);

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(true);
		expect(await session.onScreen("Ctrl+Alt+N back to this")).toBe(true);
		await session.type("x");
		expect(session.editorText()).toBe("x");

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("enter");
		await session.key("ctrl+enter");
		await turnEnds(session);

		expect(answers).toEqual([{ ...opening(3), "row-0": "off" }]);
		expect(session.editorText()).toBe("x");
	});

	it("reaches its last row in a list taller than the room it is dealt", async () => {
		const rows = 40;
		const session = await raise({ listRows: rows });
		await armed(session);

		for (let i = 1; i < rows; i++) await session.key("down");
		expect(await session.onScreen(`MARK-row-${rows - 1}`)).toBe(true);
		await session.key("enter");
		await session.key("ctrl+enter");
		await turnEnds(session);

		expect(answers).toEqual([{ ...opening(rows), [`row-${rows - 1}`]: "off" }]);
		const verdict = await session.verdict();
		expect(verdict.desync).toEqual([]);
		expect(verdict.redrawsAt).toEqual([]);
	});

	it("saves on Ctrl+S in a terminal that sends Ctrl+Enter as Enter", async () => {
		const session = await raise({ kitty: false });
		await armed(session);

		expect(await session.onScreen("Ctrl+S submit")).toBe(true);
		expect(await session.onScreen("Ctrl+Enter")).toBe(false);
		// Ctrl+Enter arrives as Enter, which cycles the row.
		await session.key("ctrl+enter");
		await session.key("ctrl+s");
		await turnEnds(session);

		expect(answers).toEqual([{ ...opening(3), "row-0": "off" }]);
	});

	it("saves on Ctrl+S under the kitty protocol too", async () => {
		const session = await raise();
		await armed(session);

		// Where the terminal is known to send it, Ctrl+Enter is what it says.
		expect(await session.onScreen("Ctrl+Enter submit")).toBe(true);
		await session.key("enter");
		await session.key("ctrl+s");
		await turnEnds(session);

		expect(answers).toEqual([{ ...opening(3), "row-0": "off" }]);
	});

	it("answers with the values it opened with when its turn is stopped", async () => {
		const session = await raise();
		await armed(session);

		await session.key("enter");
		await session.key("ctrl+alt+n");
		await session.key("escape");
		await waitFor(() => answers.length === 1, "the list to answer");

		expect(answers).toEqual([opening(3)]);
	});
});
