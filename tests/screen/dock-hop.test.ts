/**
 * Two widgets docked at once, in real pi: the hop chord reaches each of
 * them in turn and then the editor, and every footer says truthfully how
 * many presses away its keys are and where the next press goes.
 *
 * The complaint this answers: the hop only ever reached the first widget
 * that took keys, and from any widget it went straight back to the editor,
 * so with a gate and a fleet up, or two fleets, the second could never be
 * reached. Its footer said "Ctrl+Alt+N to manage" all the same.
 *
 * The real subagent extension runs here with only the supervisor
 * replaced, beside a tool that raises the real single-prompt gate.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import panelLifecycle from "../../extensions/panel-lifecycle-workflow/index.ts";
import subagentWorkflow from "../../extensions/subagent-workflow/index.ts";
import type { RunPi } from "../../lib/subagent/subagent.ts";
import { GATE_ARM_MS } from "../../lib/ui/gate-dock.ts";
import { showSinglePrompt } from "../../lib/ui/prompt-single.ts";
import { bootPi, type PiSession, sleep, strip, waitFor } from "./pi-session.ts";

vi.mock("../../lib/subagent/runpi/supervisor.ts", () => ({
	createSupervisorRunPi: () => (input: Parameters<RunPi>[0]) => runner(input),
}));

vi.setConfig({ testTimeout: 20_000 });

const HOP = "Ctrl+Alt+N";

/** A subagent the test is holding, and how to let it finish. */
interface Held {
	readonly signal: AbortSignal | undefined;
	release(): void;
}

let held: Map<string, Held>;
let runner: RunPi;
let answers: unknown[];
let pi: PiSession | undefined;

/** A tool that raises a gate and answers with what the gate said. */
function gateTool(api: ExtensionAPI): void {
	api.registerTool({
		name: "ask_gate",
		label: "Ask Gate",
		description: "Raises a gate.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const result = await showSinglePrompt(ctx, {
				title: "MARK-title Approve the thing?",
				content: () => ["MARK-body the thing"],
				actions: [{ key: "r", label: "Reject" }],
			});
			answers.push(result);
			return {
				content: [{ type: "text", text: "MARK-gate-result" }],
				details: {},
			};
		},
	});
}

beforeEach(() => {
	held = new Map();
	answers = [];
	runner = (input) =>
		new Promise((resolve) => {
			const id = input.reviewerId ?? "unnamed";
			const finish = (exitCode: number) =>
				resolve({
					exitCode,
					finalAssistantText: `MARK-answer-${id}`,
					warnings: [],
				});
			held.set(id, { signal: input.signal, release: () => finish(0) });
			input.signal?.addEventListener("abort", () => finish(130), {
				once: true,
			});
		});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	for (const one of held.values()) one.release();
	await pi?.stop();
	pi = undefined;
	vi.restoreAllMocks();
});

/** A fleet of `ids` under `runId`, as the model would ask for one. */
function fleet(runId: string, ids: readonly string[]) {
	return fauxToolCall("subagent", {
		runId,
		jobs: ids.map((id) => ({ id, cwd: "/tmp", userPrompt: "go" })),
	});
}

/** Boots pi and runs one message whose tool calls are `calls`. */
async function start(
	calls: ReturnType<typeof fauxToolCall>[],
	jobs: number,
	options: { rows?: number } = {},
): Promise<PiSession> {
	const session = await bootPi({
		cols: 100,
		rows: options.rows ?? 30,
		extensions: [subagentWorkflow, gateTool, panelLifecycle],
	});
	pi = session;
	session.faux.setResponses([
		fauxAssistantMessage(calls),
		fauxAssistantMessage("MARK-after-the-message"),
	]);
	await session.prompt("go");
	await waitFor(() => held.size === jobs, "every subagent to start");
	return session;
}

/** Two fleets up at once, alpha and beta under one, gamma and delta the other. */
async function twoFleets(): Promise<PiSession> {
	const session = await start(
		[fleet("one", ["alpha", "beta"]), fleet("two", ["gamma", "delta"])],
		4,
	);
	await waitFor(
		async () => (await boardsOnScreen(session)) === 2,
		"both boards",
	);
	return session;
}

/**
 * How many fleet boards the screen shows, by their title rules: a fleet's
 * result card carries the same title without the rule.
 */
async function boardsOnScreen(session: PiSession): Promise<number> {
	const rows = (await session.viewport()).map(strip);
	return rows.filter((row) => row.startsWith("\u2500\u2500 Subagent Fleet"))
		.length;
}

/** The screen as plain text, one string. */
async function screen(session: PiSession): Promise<string> {
	return (await session.viewport()).map(strip).join("\n");
}

/** Which subagents have been told to stop. */
function stopped(): string[] {
	return [...held.entries()]
		.filter(([, one]) => one.signal?.aborted === true)
		.map(([id]) => id)
		.sort();
}

describe("two fleets up at once", () => {
	it("reaches each board in turn, then the editor", async () => {
		const session = await twoFleets();

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("r");
		await waitFor(() => stopped().length === 1, "the first board's r");

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("r");
		await waitFor(() => stopped().length === 2, "the second board's r");

		// The first row of each board, one from either fleet.
		expect(stopped()).toEqual(["alpha", "gamma"]);
		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(true);
		await session.type("x");
		expect(session.editorText()).toBe("x");
	});

	it("says from the editor how many presses away each board is", async () => {
		const session = await twoFleets();

		const shown = await screen(session);
		expect(shown).toContain(`${HOP} to manage`);
		expect(shown).toContain(`${HOP} twice to manage`);
	});

	it("says on the first board that the chord goes on to the next", async () => {
		const session = await twoFleets();

		await session.key("ctrl+alt+n");

		const shown = await screen(session);
		expect(shown).toContain(`${HOP} to the fleet`);
		expect(shown).not.toContain("back to the editor");
		// The second board's alone: the first has the keys, so its title
		// says nothing about reaching them.
		expect(shown.split(`${HOP} to manage`).length - 1).toBe(1);
		expect(shown).not.toContain("twice");
	});

	it("says on the last board that the chord goes back to the editor", async () => {
		const session = await twoFleets();

		await session.key("ctrl+alt+n");
		await session.key("ctrl+alt+n");

		const shown = await screen(session);
		expect(shown).toContain(`${HOP} back to the editor`);
		expect(shown).toContain(`${HOP} twice to manage`);
	});

	it("gives the editor back when the board with the keys finishes", async () => {
		const session = await twoFleets();
		await session.key("ctrl+alt+n");
		await session.key("r");
		await waitFor(() => stopped().length === 1, "the first board's r");
		const first = stopped()[0] === "alpha" ? "one" : "two";
		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);

		for (const id of first === "one" ? ["gamma", "delta"] : ["alpha", "beta"])
			held.get(id)?.release();
		await waitFor(
			async () => (await boardsOnScreen(session)) === 1,
			"its board to go",
		);

		expect(session.editorFocused()).toBe(true);
		await session.type("x");
		expect(session.editorText()).toBe("x");
	});

	it("cancels only the second fleet on its Escape, handing the editor back", async () => {
		const session = await twoFleets();
		await session.key("ctrl+alt+n");
		await session.key("ctrl+alt+n");

		await session.key("escape");
		await waitFor(() => stopped().length === 2, "a fleet to stop");

		const [one, other] = stopped();
		expect([one, other]).toSatisfy(
			(both: string[]) =>
				both.join() === "alpha,beta" || both.join() === "delta,gamma",
		);
		expect(session.editorFocused()).toBe(true);
		expect(session.runtime.session.isStreaming).toBe(true);
	});

	it("passes Ctrl+C through to pi from the second board", async () => {
		const session = await twoFleets();
		await session.type("a draft");
		await session.key("ctrl+alt+n");
		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);

		await session.key("ctrl+c");

		expect(session.editorText()).toBe("");
		expect(stopped()).toEqual([]);
	});

	it("gives the editor back from the second board when the session is replaced", async () => {
		const session = await twoFleets();
		await session.key("ctrl+alt+n");
		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);

		await session.runtime.newSession();
		await waitFor(
			async () => (await boardsOnScreen(session)) === 0,
			"the boards to go",
		);

		await session.type("x");
		expect(session.editorText()).toBe("x");
	});

	it("shares the room rather than forcing pi to redraw the transcript", async () => {
		const one = Array.from({ length: 8 }, (_, i) => `one-${i}`);
		const two = Array.from({ length: 8 }, (_, i) => `two-${i}`);
		const session = await start([fleet("one", one), fleet("two", two)], 16, {
			rows: 20,
		});
		await waitFor(async () => (await boardsOnScreen(session)) >= 1, "a board");

		session.mark("ticking");
		for (const [index, id] of [...one, ...two].entries()) {
			if (index % 2 === 0) held.get(id)?.release();
			await sleep(20);
		}

		const verdict = await session.verdict();
		expect(verdict.redrawsAt.filter((at) => at.startsWith("ticking"))).toEqual(
			[],
		);
		expect(verdict.desync).toEqual([]);
	});
});

describe("a gate up beside a fleet", () => {
	async function gateAndFleet(): Promise<PiSession> {
		const session = await start(
			[fleet("one", ["alpha", "beta"]), fauxToolCall("ask_gate", {})],
			2,
		);
		await waitFor(
			async () => (await session.inBuffer("MARK-title")) > 0,
			"the gate",
		);
		await waitFor(() => !session.editorFocused(), "the gate to take focus");
		await sleep(GATE_ARM_MS + 50);
		return session;
	}

	it("says on the gate that the chord goes on to the fleet", async () => {
		const session = await gateAndFleet();

		const shown = await screen(session);
		expect(shown).toContain(`${HOP} fleet`);
		expect(shown).not.toContain(`${HOP} editor`);
		expect(shown).toContain(`${HOP} to manage`);
	});

	it("reaches the fleet from the gate, then the editor, then the gate", async () => {
		const session = await gateAndFleet();

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("r");
		await waitFor(() => stopped().length === 1, "the board's r");
		expect(stopped()).toEqual(["alpha"]);
		expect(await screen(session)).toContain(`${HOP} twice back to this`);

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(true);
		expect(await screen(session)).toContain(`${HOP} back to this`);
		expect(await screen(session)).not.toContain("twice");

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("enter");
		await waitFor(() => answers.length === 1, "the gate to answer");
		expect(answers).toEqual([{ type: "action", key: "__enter__" }]);
	});
});
