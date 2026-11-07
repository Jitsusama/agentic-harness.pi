/**
 * A fleet is said in its run record, under the session waiting on it,
 * from before it runs until its call returns.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.ts";
import { runRecordsDir } from "../../../lib/subagent/run-record.ts";
import type { RunPi } from "../../../lib/subagent/subagent.ts";
import { activateWith } from "../support/review-extension.ts";

/** What the supervisor would have spawned, had one been wanted. */
let answer: RunPi;

vi.mock("../../../lib/subagent/runpi/supervisor.ts", () => ({
	createSupervisorRunPi: () => (input: unknown) => answer(input as never),
}));

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fleet-says-"));
	vi.stubEnv("XDG_STATE_HOME", root);
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
	// With no screen, what the tool says goes to standard error.
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

const SESSION = "01a1b240-2928-74b2-80e2-553612fecd1a";

function recordOf(runId: string): Record<string, unknown> {
	const body = JSON.parse(
		readFileSync(join(runRecordsDir(), `fleet.${runId}.json`), "utf8"),
	);
	return body.runs[0];
}

/** Run one fleet through the tool as pi would, in a session. */
async function dispatch(runId: string): Promise<void> {
	const tool = activateWith(
		(await import("../../../extensions/subagent-workflow/index.ts")).default,
	).definitions.get("subagent");
	if (tool === undefined) throw new Error("no subagent tool was registered");
	await tool.execute(
		"call-1",
		{ runId, jobs: [{ id: "one", cwd: root, userPrompt: "go" }] },
		undefined,
		undefined,
		{ hasUI: false, sessionManager: { getSessionId: () => SESSION } },
	);
}

describe("a fleet's run record", () => {
	it("says it running under its session, and done once it is handed back", async () => {
		let during: Record<string, unknown> | undefined;
		answer = async () => {
			await vi.waitFor(() => expect(() => recordOf("fleet-r")).not.toThrow());
			during = recordOf("fleet-r");
			// Its answer, kept as its supervisor keeps it.
			const path = new ReviewerArtifactsStore(
				join(root, "pi", "agentic-harness.pi", "subagent-workflow"),
			).paths("fleet-r", "one").resultPath;
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				JSON.stringify({
					state: "complete",
					completedAt: new Date().toISOString(),
					usage: {
						tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
						cost: { total: 0.5 },
					},
				}),
			);
			return { exitCode: 0, finalAssistantText: "done", warnings: [] };
		};

		await dispatch("fleet-r");

		expect(during).toMatchObject({
			kind: "fleet",
			parent: SESSION,
			about: "fleet-r",
			state: "running",
		});
		expect(recordOf("fleet-r")).toMatchObject({
			state: "done",
			"pi.cost.usd": 0.5,
			members: [expect.objectContaining({ id: "one", state: "complete" })],
		});
	});
});
