/**
 * A session killed while it waited on its jobs is told, as it comes
 * back, that each ended with its pi or host, as results of their own
 * that start its turn.
 *
 * On 17 November at 00:07 five hosted conversations were resumed whole
 * after their host died, each with its turn ended, waiting on jobs that
 * died with the host (2DZF5Z's j104, 5HJZ8Z's j222 and j223). Their logs
 * read as idle and nothing started a turn, so they sat three and a half
 * hours until a reload.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	forgetRunning,
	noteRunning,
	runningFolder,
} from "../../../extensions/job-workflow/running.ts";
import { findJobHost, type JobHost } from "../../../lib/jobs/index.ts";
import { forgetParkedJobs, jobRuntime } from "../../support/job-runtime.ts";

const SESSION = "ended-with-host";
/** A pid no process has. */
const GONE = 999_999_999;
const AT = "2026-11-17T05:07:00.000Z";
const JOB = { id: "j104", label: "pnpm test:host" };

const message = (role: string, extra: Record<string, unknown> = {}) => ({
	type: "message",
	timestamp: AT,
	message: { role, content: [{ type: "text", text: "x" }], ...extra },
});

/** A log whose turn ended as it waited on its jobs: it reads as idle. */
const WAITING = [
	message("user"),
	message("assistant", { stopReason: "stop" }),
];
/** A log that stops on a tool call: killed mid-run. */
const MID_RUN = [
	message("user"),
	message("assistant", { stopReason: "toolUse" }),
];

const noteFile = () =>
	join(runningFolder(), `${encodeURIComponent(SESSION)}.json`);

afterEach(() => {
	forgetParkedJobs();
	forgetRunning(SESSION);
});

describe("a session back from a kill", () => {
	it("is told each job its gone pi had running ended with it, as a result that starts its turn", async () => {
		noteRunning(SESSION, { owner: GONE, jobs: [JOB] });
		const back = jobRuntime(createEventBus(), SESSION, WAITING);
		await back.fire("session_start", { reason: "resume" });

		expect(back.said, "one message, which starts the turn").toHaveLength(1);
		const [said = ""] = back.said;
		expect(said, "said as the job's own result").toContain("[j104]");
		expect(said, "the job is named with its label").toContain(
			"j104 (pnpm test:host) was running",
		);
		expect(said, "and the session is told to run it again").toMatch(
			/ended with it.*Run it again/,
		);
	});

	it("is told once", async () => {
		noteRunning(SESSION, { owner: GONE, jobs: [JOB] });
		const back = jobRuntime(createEventBus(), SESSION, WAITING);
		await back.fire("session_start", { reason: "resume" });
		const again = jobRuntime(createEventBus(), SESSION, WAITING);
		await again.fire("session_start", { reason: "resume" });

		expect(again.said, "the note went with the first telling").toHaveLength(
			0,
		);
	});

	it("is told nothing while the pi that noted the jobs still runs", async () => {
		noteRunning(SESSION, { owner: process.pid, jobs: [JOB] });
		const back = jobRuntime(createEventBus(), SESSION, WAITING);
		await back.fire("session_start", { reason: "resume" });

		expect(back.said, "a live pi still holds those jobs").toHaveLength(0);
		expect(existsSync(noteFile()), "and its note stands").toBe(true);
	});

	it("is told nothing on a reload, which kills nothing", async () => {
		noteRunning(SESSION, { owner: GONE, jobs: [JOB] });
		const back = jobRuntime(createEventBus(), SESSION, WAITING);
		await back.fire("session_start", { reason: "reload" });

		expect(back.said, "a reload is no return").toHaveLength(0);
	});

	it("names the dead jobs in the notice of a log that stops mid-run", async () => {
		noteRunning(SESSION, { owner: GONE, jobs: [JOB] });
		const back = jobRuntime(createEventBus(), SESSION, MID_RUN);
		await back.fire("session_start", { reason: "resume" });

		expect(back.said, "one notice").toHaveLength(1);
		const [said = ""] = back.said;
		expect(said, "it says the run was cut off").toMatch(/mid-run/);
		expect(said, "and names the job that died").toContain(
			"j104 (pnpm test:host)",
		);
	});

	it("numbers a new job past the one that died", async () => {
		noteRunning(SESSION, { owner: GONE, jobs: [JOB] });
		const events = createEventBus();
		const back = jobRuntime(events, SESSION, WAITING);
		await back.fire("session_start", { reason: "resume" });

		const job = (findJobHost(events) as JobHost).start({
			kind: "shell",
			label: "pnpm test",
		});
		expect(job.id, "never the dead job's tag").toBe("j105");
	});
});

describe("a session's running jobs", () => {
	it("are noted as they run, under this pi, and taken back as they end", async () => {
		const events = createEventBus();
		const pi = jobRuntime(events, SESSION);
		await pi.fire("session_start", { reason: "startup" });
		const job = (findJobHost(events) as JobHost).start({
			kind: "shell",
			label: "pnpm test",
		});

		const noted: unknown = JSON.parse(readFileSync(noteFile(), "utf8"));
		expect(noted, "the running job, under this pi").toEqual({
			owner: process.pid,
			jobs: [{ id: job.id, label: "pnpm test" }],
		});
		job.finish({ summary: "exited 0" });
		expect(existsSync(noteFile()), "nothing runs, so nothing is noted").toBe(
			false,
		);
	});

	it("are taken back as the session closes for good", async () => {
		const events = createEventBus();
		const pi = jobRuntime(events, SESSION);
		await pi.fire("session_start", { reason: "startup" });
		(findJobHost(events) as JobHost).start({ kind: "shell", label: "watch" });
		expect(existsSync(noteFile()), "noted while it runs").toBe(true);

		await pi.fire("session_shutdown", { reason: "quit" });
		expect(existsSync(noteFile()), "a close stops its jobs").toBe(false);
	});
});
