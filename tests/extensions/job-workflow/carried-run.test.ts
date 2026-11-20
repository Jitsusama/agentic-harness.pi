/**
 * A session whose host carried its run on past a cut-off is told how
 * that run went only when no one else will say: when it never starts,
 * or when it fails with no person there to say what comes next.
 *
 * On 20 November the 06:57 restart's resumes waited their turn behind
 * 106 others, and runs that resumed were told nothing had resumed them.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CARRIED_RUN_WAIT_MS } from "../../../extensions/job-workflow/cut-off.ts";
import { installTestHost } from "../../support/session-host.ts";
import {
	AT,
	aborted,
	activate,
	carriedRun,
	carriedRunStarts,
	ended,
	FAILED_TEXT,
	interrupted,
	killedLog,
	message,
	TIMEOUTS,
} from "./support/cut-off-session.ts";

describe("a session whose host carried its run on", () => {
	it("is told its run was cut off when the carried run never shows", async () => {
		// On 14 November the 22:22 reboot cut a run mid-answer; the next
		// host's recovery failed it ("The host stopped while the model was
		// answering, on attempt 1"), and with the record saying carried,
		// nothing told the session, which sat until a mesh message came.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const carried = { at: Date.parse(AT), running: true, runCarried: true };
			const lost = activate(
				[message("user"), ended({ ...carried, jobs: [] })],
				new EventEmitter(),
			);
			await lost.fire("session_start", { reason: "startup" });
			expect(lost.said, "nothing yet: the next host may carry it").toHaveLength(
				0,
			);
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(lost.said).toHaveLength(1);
			expect(lost.said[0]).toMatch(/mid-run, and nothing has resumed it since/);

			const failed = activate(
				[message("user"), ended({ ...carried, jobs: [] })],
				new EventEmitter(),
				"s2",
			);
			await failed.fire("session_start", { reason: "startup" });
			failed.branch.push(aborted);
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(failed.said, "a carried run that failed is no run").toHaveLength(
				1,
			);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is told nothing once the carried run shows, runs or the session ends", async () => {
		const host = installTestHost();
		// A shutdown yields once with setImmediate, which stays real.
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const record = ended({
				at: Date.parse(AT),
				running: true,
				runCarried: true,
				jobs: [],
			});
			const answered = activate([message("user"), record], new EventEmitter());
			await answered.fire("session_start", { reason: "startup" });
			answered.branch.push(message("assistant", { stopReason: "stop" }));

			const running = activate(
				[message("user"), record],
				new EventEmitter(),
				"s2",
			);
			await running.fire("session_start", { reason: "startup" });
			running.session.busy = true;

			const closed = activate(
				[message("user"), record],
				new EventEmitter(),
				"s3",
			);
			await closed.fire("session_start", { reason: "startup" });
			await closed.fire("session_shutdown", { reason: "quit" });

			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(
				{
					answered: answered.said.length,
					running: running.said.length,
					closed: closed.said.length,
				},
				"a carried run that showed, one under way, and an ended session",
			).toEqual({ answered: 0, running: 0, closed: 0 });
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is waited on when its log stops in a run, as the host carries that on too", async () => {
		// On 20 November the 04:35 restart killed runs wedged since 03:03
		// and 04:11 with no record. The next host carried each on at once,
		// yet each was told nothing had resumed it, an hour later, once idle.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const carried = activate(killedLog(), new EventEmitter());
			await carried.fire("session_start", { reason: "startup" });
			expect(carried.said, "nothing yet: the host carries it").toHaveLength(0);
			await carriedRun(carried, interrupted, message("assistant"));

			const lost = activate(killedLog(), new EventEmitter(), "s2");
			await lost.fire("session_start", { reason: "startup" });

			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(
				{ carried: carried.said.length, lost: lost.said.length },
				"told only where the run never showed",
			).toEqual({ carried: 0, lost: 1 });
			expect(lost.said[0]).toMatch(/mid-run, and nothing has resumed it since/);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is told nothing when its turn comes minutes after its return", async () => {
		// On 20 November the 06:57 restart carried X18TU2's run, whose turn
		// came at 07:09, behind 106 others; the 90 s wait had run out at
		// 07:08, so the run was told nothing had resumed it as it resumed.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const pi = activate(killedLog(), new EventEmitter());
			await pi.fire("session_start", { reason: "startup" });
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS - 1);
			expect(pi.said, "its turn not yet come").toHaveLength(0);
			await carriedRun(pi, interrupted, message("assistant"));
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(pi.said, "its run answered").toHaveLength(0);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is told its carried run failed, once that run settles", async () => {
		// The host's own result for the tool call the kill cut is no
		// answer, and a log that ends mid-run is no less carried for it.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const pi = activate(killedLog(), new EventEmitter());
			await pi.fire("session_start", { reason: "startup" });
			await carriedRun(pi, interrupted, aborted);
			expect(pi.said).toHaveLength(1);
			expect(pi.said[0]).toMatch(FAILED_TEXT);
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(pi.said, "told once").toHaveLength(1);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is told its carried run failed after a mesh message came in", async () => {
		// A mesh message or a job's report is said as an extension's
		// prompt, and no person is there to say what comes next.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const pi = activate(killedLog(), new EventEmitter());
			await pi.fire("session_start", { reason: "startup" });
			await pi.fire("input", { text: "From A2VLJN", source: "extension" });
			await carriedRun(pi, message("user"), aborted);
			expect(pi.said).toHaveLength(1);
			expect(pi.said[0]).toMatch(FAILED_TEXT);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("leaves a settle with no run started to the carried run to come", async () => {
		// A compaction settles with no run, while the carried run waits.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const pi = activate(killedLog(), new EventEmitter());
			await pi.fire("session_start", { reason: "startup" });
			await pi.fire("agent_settled", {});
			expect(pi.said, "no run has come yet").toHaveLength(0);
			await carriedRun(pi, interrupted, aborted);
			expect(pi.said, "the carried run decides").toHaveLength(1);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("leaves a run under way at the wait's end to say how it went", async () => {
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const busy = activate(killedLog(), new EventEmitter());
			await busy.fire("session_start", { reason: "startup" });
			busy.session.busy = true;

			// Idle again, as a host's run reads between its turns.
			const started = activate(killedLog(), new EventEmitter(), "s2");
			await started.fire("session_start", { reason: "startup" });
			await carriedRunStarts(started, interrupted);
			started.session.busy = false;

			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(
				{ busy: busy.said.length, started: started.said.length },
				"nothing said while a run is under way",
			).toEqual({ busy: 0, started: 0 });

			busy.session.busy = false;
			await carriedRun(busy, interrupted, aborted);
			started.branch.push(aborted);
			await started.fire("agent_settled", {});
			expect(
				[...busy.said, ...started.said].map((said) => FAILED_TEXT.test(said)),
				"each told once its run settles",
			).toEqual([true, true]);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is told the wait ran out on only once", async () => {
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const pi = activate(killedLog(), new EventEmitter());
			await pi.fire("session_start", { reason: "startup" });
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(pi.said).toHaveLength(1);
			// The notice reaches the session, so the outbox sends it no more.
			const content = [{ type: "text", text: pi.said[0] }];
			await pi.fire("message_end", { message: { role: "user", content } });
			await carriedRun(pi, interrupted, aborted);
			expect(pi.said, "the wait ended as it told").toHaveLength(1);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is told nothing of a failed carried run the person stopped or spoke over", async () => {
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const stopped = activate(killedLog(), new EventEmitter());
			await stopped.fire("session_start", { reason: "startup" });
			await carriedRun(stopped, aborted, undefined, { aborted: true });

			const typed = activate(killedLog(), new EventEmitter(), "s2");
			await typed.fire("session_start", { reason: "startup" });
			await typed.fire("input", { text: "Carry on", source: "interactive" });
			await carriedRun(typed, message("user"), aborted);

			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(
				{ stopped: stopped.said.length, typed: typed.said.length },
				"the person is there to say what comes next",
			).toEqual({ stopped: 0, typed: 0 });
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});
});
