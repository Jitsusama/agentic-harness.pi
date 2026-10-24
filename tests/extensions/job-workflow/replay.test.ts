/**
 * A job report the session has already shown is dropped when it comes
 * again, rather than starting another turn.
 *
 * A runtime pi replaced without making it stale keeps its outbox, and
 * the outbox drops a result only once it sees its message land. It no
 * longer hears the session, so it never does, and it sends the same
 * report every thirty seconds for as long as pi runs. 5KZAW2 met this
 * after two reloads ran at once on code from before reloads were made
 * one at a time: the reports for j23 and j24 arrived again and again,
 * each a turn of its own. That runtime's code can't be changed, but its
 * sends come through the session, so the live runtime can turn them away.
 */

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { OUTBOX_HEADER } from "../../../extensions/job-workflow/outbox.ts";
import { forgetParkedJobs, jobRuntime } from "../../support/job-runtime.ts";

const report = (jobId: string) =>
	`${OUTBOX_HEADER}\n\n[job ${jobId}] the reload you asked for\nReloaded, as asked.`;

/** A user message as pi's `message_end` carries it. */
const landed = (text: string) => ({
	message: { role: "user", content: [{ type: "text", text }] },
});

/** A user message as the session's history holds it. */
const entry = (text: string) => ({ type: "message", ...landed(text) });

const typed = (text: string) => ({ type: "input", text, source: "extension" });

afterEach(() => forgetParkedJobs());

describe("a job report that comes again", () => {
	it("is dropped once the session has shown it", async () => {
		const runtime = jobRuntime(createEventBus());
		await runtime.fire("session_start", { reason: "startup" });
		await runtime.fire("message_end", landed(report("j23")));

		expect(await runtime.fire("input", typed(report("j23")))).toEqual({
			action: "handled",
		});
	});

	it("is dropped when the session showed it before this runtime began", async () => {
		// The first copy landed in the runtime before the reload; this one
		// knows it only from the session's history.
		const runtime = jobRuntime(createEventBus(), "s1", [entry(report("j23"))]);
		await runtime.fire("session_start", { reason: "reload" });

		expect(await runtime.fire("input", typed(report("j23")))).toEqual({
			action: "handled",
		});
	});

	it("goes through the first time", async () => {
		const runtime = jobRuntime(createEventBus(), "s1", [entry(report("j23"))]);
		await runtime.fire("session_start", { reason: "startup" });

		expect(await runtime.fire("input", typed(report("j24")))).toBeUndefined();
	});

	it("leaves the same words alone when they are not a job report", async () => {
		// Something typed twice is the person's to send twice.
		const runtime = jobRuntime(createEventBus());
		await runtime.fire("session_start", { reason: "startup" });
		await runtime.fire("message_end", landed("again, please"));

		expect(await runtime.fire("input", typed("again, please"))).toBeUndefined();
	});
});
