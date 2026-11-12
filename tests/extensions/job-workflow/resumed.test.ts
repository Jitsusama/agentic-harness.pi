/**
 * A session that comes back, through pi's resume, a host waking a
 * parked conversation or a host restarting, numbers its new jobs on
 * from the ones its history already reported. Starting over at j1 gave
 * a new job the tag of an old report, and a report the same as one the
 * history held was turned away as a repeat: the model never heard its
 * job end, and a hosted conversation stayed busy.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { findJobHost, type JobHost } from "../../../lib/jobs/index.ts";
import { forgetParkedJobs, jobRuntime } from "../../support/job-runtime.ts";

/** A message as pi's `message_end` carries it, and as its history holds it. */
const message = (text: string) => ({
	role: "user",
	content: [{ type: "text", text }],
});

afterEach(() => {
	forgetParkedJobs();
});

/** A session that ran one job to its end, its report landed, and quit. */
async function reported(): Promise<string> {
	const events = createEventBus();
	const first = jobRuntime(events);
	await first.fire("session_start", { reason: "startup" });
	const host = findJobHost(events) as JobHost;
	host
		.start({ kind: "shell", label: "pnpm test" })
		.finish({ summary: "exited 0" });
	const [report = ""] = first.said;
	await first.fire("message_end", { message: message(report) });
	await first.fire("session_shutdown", { reason: "quit" });
	first.invalidate();
	return report;
}

describe("a resumed session", () => {
	it("numbers a new job on from those its history reported", async () => {
		const report = await reported();
		const events = createEventBus();
		const history = [{ type: "message", message: message(report) }];
		const back = jobRuntime(events, "s1", history);
		await back.fire("session_start", { reason: "resume" });

		const job = (findJobHost(events) as JobHost).start({
			kind: "shell",
			label: "pnpm test",
		});
		expect(job.id, "a new job takes a tag no report has").toBe("j2");
	});

	it("says a new job's report though it reads like an old one", async () => {
		const report = await reported();
		const events = createEventBus();
		const history = [{ type: "message", message: message(report) }];
		const back = jobRuntime(events, "s1", history);
		await back.fire("session_start", { reason: "resume" });
		const host = findJobHost(events) as JobHost;

		host
			.start({ kind: "shell", label: "pnpm test" })
			.finish({ summary: "exited 0" });
		const [said = ""] = back.said;
		const turned = await back.fire("input", {
			text: said,
			source: "extension",
		});
		expect(turned, "the report goes to the model").toBeUndefined();
		await back.fire("message_end", { message: message(said) });
		expect(host.pending?.(), "the job leaves once said").toBe(0);
	});
});
