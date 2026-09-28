/**
 * A running fleet, in real pi: a board docked above an editor that stays
 * live.
 *
 * The complaint this answers: while a fleet ran, its panel replaced the
 * editor and a listener swallowed Escape wherever focus was, so nobody
 * could type a steer, a note or the next question until every subagent had
 * finished. The board now docks above the editor and leaves it focused;
 * the hop chord reaches the board's keys and gives them back; and the board
 * leaves in the frame its result card arrives, with a card at least as tall,
 * so the screen neither jumps nor leaves blank rows behind.
 *
 * The real subagent extension runs here, inside the real InteractiveMode,
 * with only the supervisor replaced: nothing is spawned, and each subagent
 * waits until the test releases it.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import panelLifecycle from "../../extensions/panel-lifecycle-workflow/index.ts";
import subagentWorkflow from "../../extensions/subagent-workflow/index.ts";
import type { RunPi } from "../../lib/subagent/subagent.ts";
import { bootPi, type PiSession, sleep, strip, waitFor } from "./pi-session.ts";

vi.mock("../../lib/subagent/runpi/supervisor.ts", () => ({
	createSupervisorRunPi: () => (input: Parameters<RunPi>[0]) => runner(input),
}));

/**
 * How long settling the fleet's ledger takes after the fleet has finished.
 *
 * It is a file written under a lock, a few milliseconds on an idle machine
 * and far more on a busy one. Held longer than a frame here so the gap
 * between the fleet finishing and the tool returning is one pi draws in,
 * which is the gap a board that left at the finish would leave blank.
 */
const SETTLE_MS = 80;

vi.mock("../../lib/subagent/fleet.ts", async (original) => {
	const real = await original<typeof import("../../lib/subagent/fleet.ts")>();
	return {
		...real,
		createFleetLedger: (root: string) => {
			const ledger = real.createFleetLedger(root);
			return {
				...ledger,
				settle: async (id: string) => {
					await sleep(SETTLE_MS);
					await ledger.settle(id);
				},
			};
		},
	};
});

/** A subagent the test is holding, and how to let it finish. */
interface Held {
	readonly signal: AbortSignal | undefined;
	release(text?: string): void;
}

let held: Map<string, Held>;
let runner: RunPi;
let pi: PiSession | undefined;

beforeEach(() => {
	held = new Map();
	runner = (input) =>
		new Promise((resolve) => {
			const id = input.reviewerId ?? "unnamed";
			const finish = (exitCode: number, text: string) =>
				resolve({ exitCode, finalAssistantText: text, warnings: [] });
			held.set(id, {
				signal: input.signal,
				release: (text = `MARK-answer-${id}`) => finish(0, text),
			});
			input.signal?.addEventListener("abort", () => finish(130, ""), {
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

/** Boots pi with the fleet and the hop, and starts a fleet of `ids`. */
async function startFleet(
	ids: readonly string[],
	options: { cols?: number; rows?: number; history?: number } = {},
): Promise<PiSession> {
	const session = await bootPi({
		cols: options.cols ?? 100,
		rows: options.rows ?? 30,
		extensions: [subagentWorkflow, panelLifecycle],
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
		fauxAssistantMessage(
			fauxToolCall("subagent", {
				runId: "fleet-under-test",
				jobs: ids.map((id) => ({ id, cwd: "/tmp", userPrompt: "go" })),
			}),
		),
		fauxAssistantMessage("MARK-after-the-fleet"),
	]);
	session.mark("fleet");
	await session.prompt("run the fleet");
	await waitFor(() => held.size === ids.length, "every subagent to start");
	// The whole buffer, not the viewport: a board that outgrew the screen
	// is a failure the tests below should name, not a wait that times out.
	await waitFor(
		async () => (await session.inBuffer(ids[0] ?? "")) > 0,
		"the board",
	);
	return session;
}

describe("a running fleet", () => {
	it("leaves the editor focused and typable", async () => {
		const session = await startFleet(["alpha", "beta"]);

		await session.type("a steer");

		expect(session.editorText()).toBe("a steer");
		expect(await session.onScreen("Subagent Fleet")).toBe(true);
		expect(await session.onScreen("alpha")).toBe(true);
	});

	it("says how to reach its keys", async () => {
		const session = await startFleet(["alpha"]);

		expect(await session.onScreen("Ctrl+Alt+N")).toBe(true);
	});

	it("leaves Escape to pi, which stops the turn and so the fleet", async () => {
		const session = await startFleet(["alpha", "beta"]);

		await session.key("escape");

		await waitFor(
			() => held.get("alpha")?.signal?.aborted === true,
			"the subagent to be stopped",
		);
		await waitFor(
			() => !session.runtime.session.isStreaming,
			"the turn to stop",
		);
		// Stopped, not carried on: the model's next answer was never asked
		// for, which is how pi's interrupt differs from cancelling the fleet.
		expect(await session.onScreen("MARK-after-the-fleet")).toBe(false);
	});
});

describe("the board, once the hop chord reaches it", () => {
	it("cancels the selected subagent alone with r", async () => {
		const session = await startFleet(["alpha", "beta"]);

		await session.key("ctrl+alt+n");
		await session.key("down");
		await session.key("r");

		await waitFor(
			() => held.get("beta")?.signal?.aborted === true,
			"beta to be stopped",
		);
		expect(held.get("alpha")?.signal?.aborted).toBe(false);
		expect(session.runtime.session.isStreaming).toBe(true);
	});

	it("cancels the fleet with Escape and hands the editor back, the turn going on", async () => {
		const session = await startFleet(["alpha", "beta"]);

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("escape");

		await waitFor(
			() => held.get("alpha")?.signal?.aborted === true,
			"alpha to be stopped",
		);
		expect(held.get("beta")?.signal?.aborted).toBe(true);
		expect(session.editorFocused()).toBe(true);
		await waitFor(
			() => session.onScreen("MARK-after-the-fleet"),
			"the turn to carry on past the fleet",
		);
	});

	it("gives the editor back on the same chord, cancelling nothing", async () => {
		const session = await startFleet(["alpha"]);

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("ctrl+alt+n");

		expect(session.editorFocused()).toBe(true);
		await session.type("x");
		expect(session.editorText()).toBe("x");
		expect(held.get("alpha")?.signal?.aborted).toBe(false);
	});

	it("passes Ctrl+C through to pi, which clears the draft", async () => {
		const session = await startFleet(["alpha"]);
		await session.type("a draft");
		expect(session.editorText()).toBe("a draft");

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("ctrl+c");

		expect(session.editorText()).toBe("");
	});
});

describe("when the fleet finishes", () => {
	it("leaves in the frame its card arrives, with no blank rows behind", async () => {
		const session = await startFleet(["alpha", "beta", "gamma"], {
			history: 4,
		});

		session.mark("finish");
		for (const one of held.values()) one.release();
		await waitFor(
			() => session.onScreen("MARK-after-the-fleet"),
			"the turn to finish",
		);
		await sleep(50);

		const verdict = await session.verdict();
		expect(verdict.desync).toEqual([]);
		expect(verdict.hygiene).toEqual([]);
		expect(verdict.blankMax).toBe(0);
		expect(await session.onScreen("Ctrl+Alt+N")).toBe(false);
		expect(session.editorFocused()).toBe(true);
	});

	it("gives the editor back when the board had it", async () => {
		const session = await startFleet(["alpha"]);
		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);

		held.get("alpha")?.release();
		await waitFor(
			() => session.onScreen("MARK-after-the-fleet"),
			"the turn to finish",
		);

		expect(session.editorFocused()).toBe(true);
	});
});

describe("a board taller than the room", () => {
	it("shrinks to fit rather than forcing pi to redraw the transcript", async () => {
		const ids = Array.from({ length: 16 }, (_, i) => `job-${i}`);
		const session = await startFleet(ids, { rows: 20, history: 3 });

		session.mark("ticking");
		for (const [index, id] of ids.entries()) {
			if (index % 2 === 0) held.get(id)?.release();
			await sleep(20);
		}
		const viewport = (await session.viewport()).map(strip);

		const verdict = await session.verdict();
		expect(verdict.redrawsAt.filter((at) => at.startsWith("ticking"))).toEqual(
			[],
		);
		expect(viewport.some((row) => row.includes("more"))).toBe(true);
		expect(verdict.desync).toEqual([]);
	});
});

describe("a session replaced under a running fleet", () => {
	it("takes the board away and gives the editor back, even from the board", async () => {
		const session = await startFleet(["alpha"]);
		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);

		await session.runtime.newSession();
		await waitFor(
			async () => !(await session.onScreen("Subagent Fleet")),
			"the board to go",
		);

		expect(held.get("alpha")?.signal?.aborted).toBe(true);
		await session.type("x");
		expect(session.editorText()).toBe("x");
	});
});
