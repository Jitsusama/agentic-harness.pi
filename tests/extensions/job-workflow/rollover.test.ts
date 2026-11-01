/**
 * A rollover hands a session's background jobs to the fresh session
 * that carries its conversation on, as a reload hands them to the
 * runtime it starts. pi plays the rollover as a resume into the fresh
 * log, whose header names the old log as its parent; a resume into any
 * other log still stops them.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findJobHost,
	type JobHost,
	jobStopOf,
} from "../../../lib/jobs/index.ts";
import {
	forgetParkedJobs,
	type JobRuntime,
	jobRuntime,
} from "../../support/job-runtime.ts";

let dir: string;
let oldLog: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rollover-jobs-"));
	oldLog = join(dir, "old.jsonl");
	writeFileSync(oldLog, `${JSON.stringify({ type: "session", id: "s1" })}\n`);
});

afterEach(() => {
	forgetParkedJobs();
	rmSync(dir, { recursive: true, force: true });
});

/** A log on disk for session `id`, naming `parent` as its parent. */
function logOf(id: string, parent?: string): string {
	const path = join(dir, `${id}.jsonl`);
	const header = {
		type: "session",
		id,
		...(parent ? { parentSession: parent } : {}),
	};
	writeFileSync(path, `${JSON.stringify(header)}\n`);
	return path;
}

/** Switch `from` into the log at `target`, for session `id`, as pi does. */
async function switchInto(
	events: EventBus,
	from: JobRuntime,
	target: string,
	id: string,
): Promise<JobRuntime> {
	await from.fire("session_shutdown", {
		reason: "resume",
		targetSessionFile: target,
	});
	from.invalidate();
	const next = jobRuntime(events, id, [], target);
	await next.fire("session_start", {
		reason: "resume",
		previousSessionFile: oldLog,
	});
	return next;
}

async function startedOn(events: EventBus) {
	const first = jobRuntime(events, "s1", [], oldLog);
	await first.fire("session_start", { reason: "startup" });
	return { first, host: findJobHost(events) as JobHost };
}

describe("a rollover", () => {
	it("leaves a running job running, and the fresh session says its result", async () => {
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		const job = host.start({ kind: "shell", label: "nix build .#kernel" });

		const fresh = await switchInto(events, first, logOf("s2", oldLog), "s2");
		expect(job.signal.aborted).toBe(false);
		expect(findJobHost(events)?.pending?.()).toBe(1);

		job.finish({ summary: "exited 0 after 50 minutes" });
		expect(first.said).toEqual([]);
		expect(fresh.said).toHaveLength(1);
		expect(fresh.said[0]).toContain(`[${job.id}]`);
		expect(fresh.said[0]).toContain("exited 0 after 50 minutes");
	});
});

describe("a resume into another conversation", () => {
	it.each([
		["a log with no parent", undefined],
		["a log another session is the parent of", "/elsewhere/other.jsonl"],
	])("stops the jobs, for %s", async (_name, parent) => {
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		const job = host.start({ kind: "shell", label: "nix build" });

		const other = await switchInto(events, first, logOf("s3", parent), "s3");
		expect(jobStopOf(job.signal)).toBe("session");
		expect(findJobHost(events)?.pending?.()).toBe(0);
		expect(other.said).toEqual([]);
	});
});
