/**
 * A fleet run in the background returns at once and says its result
 * through the job host when it ends.
 *
 * The call returning is the whole point: the person gets the editor
 * back and the model carries on. What makes that safe is that the
 * result is not lost, that stopping the job stops the fleet, and that a
 * session with nobody to say the result refuses rather than running
 * work whose answer would go nowhere.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	announceJobHost,
	type Job,
	type JobHost,
	type JobOutcome,
} from "../../../lib/jobs/index.ts";
import type { RunPi } from "../../../lib/subagent/subagent.ts";
import { until } from "../../support/until.ts";
import { activateWith } from "../support/review-extension.ts";

let answer: RunPi;

vi.mock("../../../lib/subagent/runpi/supervisor.ts", () => ({
	createSupervisorRunPi: () => (input: unknown) => answer(input as never),
}));

/** How many times a board was taken down. */
let boardsClosed = 0;

vi.mock(
	"../../../extensions/subagent-workflow/progress-render.ts",
	async (original) => {
		const real =
			await original<
				typeof import("../../../extensions/subagent-workflow/progress-render.ts")
			>();
		return {
			...real,
			createFleetProgressReporter: (
				...args: Parameters<typeof real.createFleetProgressReporter>
			) => {
				const reporter = real.createFleetProgressReporter(...args);
				return {
					...reporter,
					close: () => {
						boardsClosed++;
						reporter.close();
					},
				};
			},
		};
	},
);

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fleet-background-"));
	vi.stubEnv("XDG_STATE_HOME", root);
	// The person's own config is not this test's to read.
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
	vi.spyOn(console, "error").mockImplementation(() => {});
	boardsClosed = 0;
	answer = async () => ({
		exitCode: 0,
		finalAssistantText: "done",
		warnings: [],
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** A host that records what it was asked, and a way to stop its job. */
function recordingHost() {
	const outcomes: JobOutcome[] = [];
	const stop = new AbortController();
	const delivered: (() => void)[] = [];
	const host: JobHost = {
		start: (): Job => ({
			id: "j7",
			signal: stop.signal,
			finish: (outcome) => outcomes.push(outcome),
			onDelivered: (listener) => delivered.push(listener),
			withdraw: () => false,
		}),
	};
	return { host, outcomes, stop, delivered };
}

/** The tool, activated with a host announced on its bus, or none. */
async function subagentTool(host?: JobHost) {
	const stub = activateWith(
		(await import("../../../extensions/subagent-workflow/index.ts")).default,
	);
	if (host) announceJobHost(stub.pi.events as never, host);
	const tool = stub.definitions.get("subagent");
	if (tool === undefined) throw new Error("no subagent tool was registered");
	return tool;
}

/** Run one fleet in the background, as pi would call it. */
async function inBackground(host?: JobHost, turn?: AbortSignal) {
	const tool = await subagentTool(host);
	return (await tool.execute(
		"call-1",
		{
			runId: "fleet-bg",
			background: true,
			jobs: [{ id: "one", cwd: root, userPrompt: "go" }],
		},
		turn,
		undefined,
		{ hasUI: false },
	)) as { content: { text: string }[] };
}

/** The first text a tool result carries. */
const textOf = (result: { content: { text: string }[] }) =>
	result.content[0]?.text ?? "";

describe("a fleet in the background", () => {
	it("returns before the fleet finishes, naming the job", async () => {
		let release: (() => void) | undefined;
		answer = () =>
			new Promise((resolve) => {
				release = () =>
					resolve({ exitCode: 0, finalAssistantText: "done", warnings: [] });
			});
		const { host, outcomes } = recordingHost();

		const returned = await Promise.race([
			inBackground(host),
			new Promise<"still running">((resolve) =>
				setTimeout(() => resolve("still running"), 1_000),
			),
		]);

		expect(returned).not.toBe("still running");
		if (returned === "still running") return;
		expect(textOf(returned)).toContain("j7");
		expect(textOf(returned)).toMatch(/do not poll/i);
		await until("the run to start", () => release !== undefined);
		expect(outcomes).toHaveLength(0);
		release?.();
		await until("the fleet to end", () => outcomes.length === 1);
	});

	it("says its summary through the host when it ends", async () => {
		const { host, outcomes } = recordingHost();
		await inBackground(host);
		await until("the fleet to end", () => outcomes.length === 1);
		expect(outcomes[0]?.summary).toContain("Fleet fleet-bg: 1/1 complete");
		expect(
			outcomes[0]?.failed,
			"a fleet whose one job completed is not said to have failed",
		).toBeFalsy();
	});

	it("stops the fleet when its job is stopped", async () => {
		let running = false;
		let stoppedFleet = false;
		answer = (input) =>
			new Promise((_resolve, reject) => {
				running = true;
				input.signal?.addEventListener("abort", () => {
					stoppedFleet = true;
					reject(new Error("cancelled"));
				});
			});
		const { host, outcomes, stop } = recordingHost();
		await inBackground(host);
		await until("the run to start", () => running);
		stop.abort();
		await until("the run to be stopped", () => stoppedFleet);
		await until("the fleet to end", () => outcomes.length === 1);
	});

	it("outlives an Escape on the turn that started it", async () => {
		// The hazard other harnesses shipped: interrupting the model's turn
		// killed every child it had put in the background, so the one
		// thing background was for was undone by the most common key.
		let release: (() => void) | undefined;
		let interrupted = false;
		answer = (input) =>
			new Promise((resolve) => {
				input.signal?.addEventListener("abort", () => {
					interrupted = true;
				});
				release = () =>
					resolve({ exitCode: 0, finalAssistantText: "done", warnings: [] });
			});
		const { host, outcomes } = recordingHost();
		const turn = new AbortController();
		await inBackground(host, turn.signal);
		await until("the run to start", () => release !== undefined);
		turn.abort();
		release?.();
		await until("the fleet to end", () => outcomes.length === 1);
		expect(
			interrupted,
			"aborting the turn that started the fleet does not abort its job",
		).toBe(false);
		expect(
			outcomes[0]?.failed,
			"a fleet that outlived an Escape is not said to have failed",
		).toBeFalsy();
	});

	it("keeps its board up until the result is in the session", async () => {
		const { host, outcomes, delivered } = recordingHost();
		await inBackground(host);
		await until("the fleet to end", () => outcomes.length === 1);
		expect(boardsClosed).toBe(0);
		for (const listener of delivered) listener();
		expect(boardsClosed).toBeGreaterThan(0);
	});

	it("takes its board down when it is stopped with nobody to tell", async () => {
		let running = false;
		answer = (input) =>
			new Promise((_resolve, reject) => {
				running = true;
				input.signal?.addEventListener("abort", () =>
					reject(new Error("cancelled")),
				);
			});
		const { host, stop } = recordingHost();
		await inBackground(host);
		await until("the run to start", () => running);
		stop.abort();
		await until("the board to come down", () => boardsClosed > 0);
	});

	it("reaches the model once, as a prompt, through the real job host", async () => {
		const stub = activateWith(
			(await import("../../../extensions/subagent-workflow/index.ts")).default,
		);
		const prompts: string[] = [];
		const lifecycle = new Map<
			string,
			(event: unknown, ctx: unknown) => unknown
		>();
		const jobWorkflow = (
			await import("../../../extensions/job-workflow/index.ts")
		).default;
		jobWorkflow({
			events: stub.pi.events,
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				lifecycle.set(name, handler),
			registerCommand: () => {},
			registerTool: () => {},
			sendUserMessage: (text: string) => prompts.push(text),
		} as never);
		const session = { isIdle: () => true, ui: { setStatus: () => {} } };
		await lifecycle.get("session_start")?.({ reason: "startup" }, session);

		await stub.definitions.get("subagent")?.execute(
			"call-1",
			{
				runId: "fleet-e2e",
				background: true,
				jobs: [{ id: "one", cwd: root, userPrompt: "go" }],
			},
			undefined,
			undefined,
			{ hasUI: false },
		);
		await until(
			"the model to be prompted with the result",
			() => prompts.length === 1,
		);
		expect(prompts[0]).toContain("Fleet fleet-e2e: 1/1 complete");
		await lifecycle.get("session_shutdown")?.({ reason: "quit" }, session);
	});

	it("refuses, running nothing, when nobody could say the result", async () => {
		let ran = false;
		answer = async () => {
			ran = true;
			return { exitCode: 0, finalAssistantText: "done", warnings: [] };
		};
		await expect(inBackground()).rejects.toThrow(/job-workflow/);
		expect(ran, "no job runs when nobody could say the result").toBe(false);
	});
});

/**
 * How long a handed-off fleet's job gets to end. Short of the test's own
 * timeout, so a job that never ends fails naming what was waited on.
 */
const ENDS_WITHIN_MS = 2_000;

describe("a fleet waited on", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("still running after a minute moves to a job, which says how it ended", async () => {
		let release: (() => void) | undefined;
		answer = () =>
			new Promise((resolve) => {
				release = () =>
					resolve({ exitCode: 0, finalAssistantText: "done", warnings: [] });
			});
		const { host, outcomes } = recordingHost();
		const tool = await subagentTool(host);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const returned = tool.execute(
			"call-1",
			{
				runId: "fleet-fg",
				jobs: [{ id: "one", cwd: root, userPrompt: "go" }],
			},
			undefined,
			undefined,
			{ hasUI: false },
		) as Promise<{ content: { text: string }[] }>;
		// Sizing the fleet reads files and runs ps before the minute starts,
		// so the clock moves only once the subagent has been asked, which is
		// after. Waited on by I/O turns, since the timers are the test's.
		const deadline = Date.now() + ENDS_WITHIN_MS;
		while (release === undefined && Date.now() < deadline) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(release, "the subagent was asked").toBeDefined();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(textOf(await returned)).toContain("now runs as background fleet j7");
		vi.useRealTimers();
		release?.();
		await until("the job to finish", () => outcomes.length > 0, ENDS_WITHIN_MS);
		expect(outcomes[0]?.summary).toContain("Fleet fleet-fg: 1/1 complete");
	});
});
