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
async function inBackground(host?: JobHost) {
	const tool = await subagentTool(host);
	return (await tool.execute(
		"call-1",
		{
			runId: "fleet-bg",
			background: true,
			jobs: [{ id: "one", cwd: root, userPrompt: "go" }],
		},
		undefined,
		undefined,
		{ hasUI: false },
	)) as { content: { text: string }[] };
}

/** The first text a tool result carries. */
const textOf = (result: { content: { text: string }[] }) =>
	result.content[0]?.text ?? "";

/** Wait until the check holds, or fail saying it never did. */
async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(check()).toBe(true);
}

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
		await until(() => release !== undefined);
		expect(outcomes).toHaveLength(0);
		release?.();
		await until(() => outcomes.length === 1);
	});

	it("says its summary through the host when it ends", async () => {
		const { host, outcomes } = recordingHost();
		await inBackground(host);
		await until(() => outcomes.length === 1);
		expect(outcomes[0]?.summary).toContain("Fleet fleet-bg: 1/1 complete");
		expect(outcomes[0]?.failed).toBeFalsy();
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
		await until(() => running);
		stop.abort();
		await until(() => stoppedFleet);
		await until(() => outcomes.length === 1);
	});

	it("keeps its board up until the result is in the session", async () => {
		const { host, outcomes, delivered } = recordingHost();
		await inBackground(host);
		await until(() => outcomes.length === 1);
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
		await until(() => running);
		stop.abort();
		await until(() => boardsClosed > 0);
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
		await until(() => prompts.length === 1);
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
		expect(ran).toBe(false);
	});
});
