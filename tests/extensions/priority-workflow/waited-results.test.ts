/**
 * A background job's result, when the person started its job, starts a
 * run marked as typed. On 15 November Joel's "run the tests" went to a
 * job, his run ended, and the run its result started went out as bulk,
 * behind every agent's upload, while he waited on it (B8RBNW).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sayTypedTurns } from "../../../extensions/priority-workflow/index.ts";
import { JOBS_FINISHED } from "../../../lib/jobs/host.ts";
import { OUTBOX_HEADER } from "../../../lib/jobs/report.ts";

type Handler = (event: unknown) => Promise<void>;

let runtime: string;

beforeEach(() => {
	runtime = mkdtempSync(join(tmpdir(), "waited-results-"));
	vi.stubEnv("XDG_RUNTIME_DIR", runtime);
	vi.stubEnv("SUBAGENT_RUN_ID", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(runtime, { recursive: true, force: true });
});

/** The extension's typed marks, with pi's events and its bus to raise. */
function loaded() {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const pi = {
		on: (name: string, handler: Handler) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: {
			on: (name: string, listener: (data: unknown) => void) => {
				listeners.set(name, [...(listeners.get(name) ?? []), listener]);
				return () => {};
			},
			emit: (name: string, data: unknown) => {
				for (const listener of listeners.get(name) ?? []) listener(data);
			},
		},
	} as unknown as Pick<ExtensionAPI, "on" | "events">;
	sayTypedTurns(pi);
	const fire = async (name: string, event: object = {}) => {
		for (const handler of handlers.get(name) ?? [])
			await handler({ type: name, ...event });
	};
	const jobEnded = (jobId: string, toolCallId: string) =>
		pi.events.emit(JOBS_FINISHED, {
			jobId,
			kind: "bash",
			toolCallId,
			failed: false,
		});
	return { fire, jobEnded };
}

const marked = () =>
	existsSync(join(runtime, "pi", "typed", String(process.pid)));

const report = (jobId: string) =>
	`${OUTBOX_HEADER}\n\n[${jobId}] the tests\nexited 0 after 3 minutes`;

/** A typed run that starts a job by its call, then ends. */
async function typedRunStarting(
	fire: ReturnType<typeof loaded>["fire"],
	toolCallId: string,
) {
	await fire("input", { source: "interactive", text: "run the tests" });
	await fire("agent_start");
	await fire("tool_execution_start", { toolCallId, toolName: "bash" });
	await fire("agent_end");
}

describe("a job's result after a typed run", () => {
	it("marks the run it starts when the person's run started the job", async () => {
		const { fire, jobEnded } = loaded();
		await typedRunStarting(fire, "call-1");
		expect(marked(), "the typed run has ended").toBe(false);

		jobEnded("j4", "call-1");
		await fire("input", { source: "extension", text: report("j4") });
		await fire("agent_start");

		expect(marked(), "the person waits on this result").toBe(true);
		await fire("agent_end");
		expect(marked(), "and only for the run it starts").toBe(false);
		await fire("session_shutdown");
	});

	it("leaves a result unmarked when an untyped run started its job", async () => {
		const { fire, jobEnded } = loaded();
		await fire("input", { source: "extension", text: "a wake" });
		await fire("agent_start");
		await fire("tool_execution_start", { toolCallId: "call-1" });
		await fire("agent_end");

		jobEnded("j4", "call-1");
		await fire("input", { source: "extension", text: report("j4") });
		await fire("agent_start");

		expect(marked(), "nobody typed what started it").toBe(false);
		await fire("session_shutdown");
	});
});
