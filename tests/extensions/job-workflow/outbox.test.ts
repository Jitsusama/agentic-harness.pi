/**
 * A finished job's result reaches the model once, and never races the
 * person.
 *
 * Measured on pi 0.87.1: a turn started while the person's own prompt
 * is between `input` and `agent_start` takes that prompt's place, loses
 * it, and leaves a run Escape cannot stop. A user message queued while
 * a run streams is put into the person's editor by Escape. A prompt
 * during a compaction is refused. So the outbox sends only from idle,
 * holds while anything else is under way, and keeps a result until its
 * message is seen in the session.
 */

import { describe, expect, it } from "vitest";
import {
	createOutbox,
	type JobResult,
	PROMPT_WAIT_MS,
} from "../../../extensions/job-workflow/outbox.ts";

const result = (jobId: string, text = `${jobId} finished`): JobResult => ({
	jobId,
	label: `fleet ${jobId}`,
	text,
});

function outbox(options: { failSends?: number } = {}) {
	const sent: string[] = [];
	let clock = 0;
	let failures = options.failSends ?? 0;
	const session = { busy: false };
	const box = createOutbox({
		idle: () => !session.busy,
		send: (message) => {
			if (failures > 0) {
				failures--;
				throw new Error("pi is gone");
			}
			sent.push(message);
		},
		now: () => clock,
	});
	return {
		box,
		sent,
		session,
		advance: (ms: number) => {
			clock += ms;
			box.tick();
		},
	};
}

describe("when a result is posted", () => {
	it("sends it at once from idle, labelled as automated", () => {
		const { box, sent } = outbox();
		box.post(result("j1", "all three lanes agreed"));
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("all three lanes agreed");
		expect(sent[0]).toContain("fleet j1");
		expect(sent[0]).toMatch(/automated/i);
		expect(sent[0]).toMatch(/no human input/i);
	});

	it("holds it while a run streams and sends it once the run settles", () => {
		const { box, sent, session } = outbox();
		session.busy = true;
		box.runStarted();
		box.post(result("j1"));
		box.tick();
		expect(sent).toHaveLength(0);
		session.busy = false;
		box.runSettled();
		expect(sent).toHaveLength(1);
	});

	it("holds it while the person's prompt is on its way to a run", () => {
		const { box, sent, session } = outbox();
		box.promptSubmitted();
		box.post(result("j1"));
		expect(sent).toHaveLength(0);
		session.busy = true;
		box.runStarted();
		box.tick();
		expect(sent).toHaveLength(0);
		session.busy = false;
		box.runSettled();
		expect(sent).toHaveLength(1);
	});

	it("lets the person's prompt go when it never became a run", () => {
		const { box, sent, advance } = outbox();
		box.promptSubmitted();
		box.post(result("j1"));
		advance(PROMPT_WAIT_MS - 1);
		expect(sent).toHaveLength(0);
		advance(1);
		expect(sent).toHaveLength(1);
	});

	it("holds it while pi is not idle, as during a compaction", () => {
		const { box, sent, session } = outbox();
		session.busy = true;
		box.post(result("j1"));
		box.tick();
		expect(sent).toHaveLength(0);
		session.busy = false;
		box.tick();
		expect(sent).toHaveLength(1);
	});

	it("says everything that finished during a run in one message", () => {
		const { box, sent, session } = outbox();
		session.busy = true;
		box.runStarted();
		box.post(result("j1"));
		box.post(result("j2"));
		session.busy = false;
		box.runSettled();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("j1 finished");
		expect(sent[0]).toContain("j2 finished");
	});
});

describe("exactly once", () => {
	it("lets a result go once its message is seen in the session", () => {
		const { box, sent } = outbox();
		box.post(result("j1"));
		box.promptSubmitted();
		box.runStarted();
		box.seen(sent[0] ?? "");
		box.runSettled();
		expect(box.waiting()).toHaveLength(0);
		expect(sent).toHaveLength(1);
	});

	it("sends it again when its run ended without it", () => {
		const { box, sent } = outbox();
		box.post(result("j1"));
		box.promptSubmitted();
		box.runStarted();
		box.runSettled();
		expect(sent).toHaveLength(2);
		expect(box.waiting()).toHaveLength(1);
	});

	it("ignores the person quoting a job, which is not its own message", () => {
		const { box } = outbox();
		box.post(result("j1"));
		box.seen("what did [job j1] say about the lanes?");
		expect(box.waiting()).toHaveLength(1);
	});

	it("sends a result posted while its own message is out after that one lands", () => {
		const { box, sent } = outbox();
		box.post(result("j1"));
		box.post(result("j2"));
		expect(sent).toHaveLength(1);
		box.promptSubmitted();
		box.runStarted();
		box.seen(sent[0] ?? "");
		box.runSettled();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("j2 finished");
		expect(sent[1]).not.toContain("j1 finished");
	});
});

describe("when a send goes nowhere", () => {
	it("keeps the result when sending throws, and tries again later", () => {
		const { box, sent, advance } = outbox({ failSends: 1 });
		box.post(result("j1"));
		expect(sent).toHaveLength(0);
		expect(box.waiting()).toHaveLength(1);
		advance(PROMPT_WAIT_MS);
		expect(sent).toHaveLength(1);
	});

	it("tries again when a sent prompt never became a run, but not sooner", () => {
		const { box, sent, advance } = outbox();
		box.post(result("j1"));
		advance(PROMPT_WAIT_MS - 1);
		expect(sent).toHaveLength(1);
		advance(1);
		expect(sent).toHaveLength(2);
	});
});
