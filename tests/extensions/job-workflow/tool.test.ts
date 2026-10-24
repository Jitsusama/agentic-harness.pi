/**
 * The `jobs` tool over a registry a reload carried from older code.
 *
 * A reload hands the session's registry on as it is, so a session that
 * started before the tool existed holds a registry without
 * `stopForAgent` from then on, however often it reloads. On 24 October
 * the first live stop answered "jobs?.stopForAgent is not a function"
 * and the job ran on. The registry every version has carried is
 * `createJobs` with `stopForAgent` taken away.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	createJobs,
	type Jobs,
} from "../../../extensions/job-workflow/jobs.ts";
import type { JobResult } from "../../../extensions/job-workflow/outbox.ts";
import { registerJobsTool } from "../../../extensions/job-workflow/tool.ts";
import { jobStopOf } from "../../../lib/jobs/index.ts";

interface Answer {
	content: { type: string; text?: string }[];
	isError?: boolean;
}

interface Tool {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
	) => Promise<Answer>;
}

/** A registry as code from before the tool built it. */
function olderRegistry(posted: JobResult[]): Omit<Jobs, "stopForAgent"> {
	const { stopForAgent: _newer, ...older } = createJobs(
		(result) => posted.push(result),
		() => {},
	);
	return older;
}

/** The tool, reading `jobs` as the session's registry. */
function toolOver(jobs: Omit<Jobs, "stopForAgent">) {
	let tool: Tool | undefined;
	const pi = {
		registerTool: (registered: Tool) => {
			tool = registered;
		},
	};
	registerJobsTool(pi as unknown as ExtensionAPI, () => jobs);
	if (!tool) throw new Error("the jobs tool was not registered");
	const registered = tool;
	return async (params: Record<string, unknown>) => {
		const answer = await registered.execute("call-1", params);
		return { ...answer, text: answer.content[0]?.text ?? "" };
	};
}

describe("the jobs tool over a registry carried from older code", () => {
	it("stops a running job, through the stop that registry has", async () => {
		const posted: JobResult[] = [];
		const jobs = olderRegistry(posted);
		const job = jobs.start({ kind: "shell", label: "sleep 4321 | cat" });
		const call = toolOver(jobs);

		const answer = await call({ action: "stop", id: job.id });

		expect(answer.isError).not.toBe(true);
		expect(answer.text).toContain(`Stopped ${job.id}`);
		expect(job.signal.aborted).toBe(true);
		// The older stop is the person's, and it says so in a message; the
		// answer warns that the message is this stop, not a second one.
		expect(jobStopOf(job.signal)).toBe("person");
		expect(posted).toHaveLength(1);
		expect(answer.text).toMatch(/message .* follows/i);
	});

	it("refuses a job that has finished, or one it does not hold", async () => {
		const jobs = olderRegistry([]);
		const done = jobs.start({ kind: "subagent", label: "three lanes" });
		done.finish({ summary: "agreed" });
		const call = toolOver(jobs);

		const finished = await call({ action: "stop", id: done.id });
		const unknown = await call({ action: "stop", id: "j99" });

		expect(finished.isError).toBe(true);
		expect(finished.text).toMatch(/already finished/);
		expect(unknown.isError).toBe(true);
		expect(unknown.text).toMatch(/holds no job j99/);
	});
});
