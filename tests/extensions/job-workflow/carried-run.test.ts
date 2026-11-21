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
import {
	CARRIED_RUN_RECHECK_MS,
	CARRIED_RUN_WAIT_MS,
} from "../../../extensions/job-workflow/cut-off.ts";
import { steerText } from "../../../extensions/mesh-workflow/steer.ts";
import { automatedText } from "../../../lib/internal/automated.ts";
import { FROM_MACHINE } from "../../../lib/mesh/steer-who.ts";
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
	noticeSeen,
	refused,
	refusedUnmarked,
	stoppedShort,
	TIMEOUTS,
} from "./support/cut-off-session.ts";

/** Well past the 90 s wait the 06:57 restart ran out, and short of the clock. */
const TWELVE_MINUTES = 12 * 60_000;

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
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS - 1);
			expect(lost.said, "nothing yet: the next host may carry it").toHaveLength(
				0,
			);
			await vi.advanceTimersByTimeAsync(1);
			expect(lost.said, "told at half an hour").toHaveLength(1);
			expect(CARRIED_RUN_WAIT_MS, "the README's half an hour").toBe(
				30 * 60_000,
			);
			expect(lost.said[0]).toMatch(/mid-run, and nothing has resumed it since/);

			const failed = activate(
				[message("user"), ended({ ...carried, jobs: [] })],
				new EventEmitter(),
				"s2",
			);
			await failed.fire("session_start", { reason: "startup" });
			// A carried run that never settles, as a host killed again leaves
			// it, is read from its log once the clock tells.
			failed.branch.push(aborted);
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(failed.said, "a carried run that failed is no run").toHaveLength(
				1,
			);
			expect(failed.said[0]).toMatch(FAILED_TEXT);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is told nothing once the carried run shows or the session ends", async () => {
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
					closed: closed.said.length,
				},
				"a carried run that showed, and an ended session",
			).toEqual({ answered: 0, closed: 0 });
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
			await vi.advanceTimersByTimeAsync(TWELVE_MINUTES);
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
			// Seen, so a second notice would go out at once.
			await noticeSeen(pi);
			await carriedRun(pi, interrupted, aborted);
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(pi.said, "told once, though another run failed").toHaveLength(1);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is told its carried run failed when it ended on a tool call or an error after one", async () => {
		// A run that called a tool and then failed answered nothing, nor did
		// one a second kill cut on its call.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const calling = message("assistant", { stopReason: "toolUse" });
			const failed = activate(killedLog(), new EventEmitter());
			await failed.fire("session_start", { reason: "startup" });
			const result = message("toolResult");
			await carriedRunStarts(failed, interrupted, calling, result, aborted);
			failed.session.busy = false;
			await failed.fire("agent_settled", {});

			const cut = activate(killedLog(), new EventEmitter(), "s2");
			await cut.fire("session_start", { reason: "startup" });
			await carriedRun(cut, interrupted, calling);

			expect(
				[...failed.said, ...cut.said].map((said) => FAILED_TEXT.test(said)),
				"each told its run failed",
			).toEqual([true, true]);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is told nothing when its carried run called a tool and then answered", async () => {
		// Its last answer decides, not the first.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const pi = activate(killedLog(), new EventEmitter());
			await pi.fire("session_start", { reason: "startup" });
			const calling = message("assistant", { stopReason: "toolUse" });
			const answered = message("assistant", { stopReason: "stop" });
			await carriedRunStarts(pi, interrupted, calling, message("toolResult"));
			pi.branch.push(answered);
			pi.session.busy = false;
			await pi.fire("agent_settled", {});
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(pi.said, "the carried run answered").toHaveLength(0);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is told once it rests when it was busy with no run of its own as the wait ran out", async () => {
		// A compaction keeps a session busy with no run started.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const pi = activate(killedLog(), new EventEmitter());
			await pi.fire("session_start", { reason: "startup" });
			pi.session.busy = true;
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(pi.said, "nothing said while it is busy").toHaveLength(0);
			pi.session.busy = false;
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_RECHECK_MS);
			expect(pi.said, "told once it rests").toHaveLength(1);
			expect(pi.said[0]).toMatch(/mid-run, and nothing has resumed it since/);
			await noticeSeen(pi);
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(pi.said, "told once").toHaveLength(1);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("is told its carried run failed after an extension's prompt or another's steer", async () => {
		// A job's report is said as an extension's prompt under the
		// automated header, and no person is there to say what comes next.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const pi = activate(killedLog(), new EventEmitter());
			await pi.fire("session_start", { reason: "startup" });
			const said = automatedText("a peer sent a message", "From A2VLJN");
			await pi.fire("input", { text: said, source: "extension" });
			await carriedRun(pi, message("user"), aborted);

			// A peer's steer or the machine's carries no automated header,
			// and is no person either.
			const asked = activate(killedLog(), new EventEmitter(), "s2");
			await asked.fire("session_start", { reason: "startup" });
			const peer = { text: "are you back?", from: "P9R1KI", file: "f" };
			const text = steerText(peer, { busy: false });
			await asked.fire("input", { text, source: "extension" });
			await carriedRun(asked, message("user"), aborted);

			const told = activate(killedLog(), new EventEmitter(), "s3");
			await told.fire("session_start", { reason: "startup" });
			const machine = { text: "carry on", from: FROM_MACHINE, file: "f" };
			const says = steerText(machine, { busy: false });
			await told.fire("input", { text: says, source: "extension" });
			await carriedRun(told, message("user"), aborted);

			expect(
				[...pi.said, ...asked.said, ...told.said].map((it) =>
					FAILED_TEXT.test(it),
				),
				"a mesh message, a peer's steer and the machine's each told",
			).toEqual([true, true, true]);
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});

	it("leaves a run that answered nothing to the carried run to come", async () => {
		// A job's report posted on the return runs before the recovery, and
		// durable admits nothing while it holds the carried run cut off.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const pi = activate(killedLog(), new EventEmitter());
			await pi.fire("session_start", { reason: "startup" });
			await carriedRun(pi, undefined, undefined);
			// What the host leaves for a run durable refused as busy, marked
			// and, from a host before the mark, in durable's words.
			await carriedRun(pi, refused, undefined);
			await carriedRun(pi, refusedUnmarked, undefined);
			expect(pi.said, "a refused run is not the carried one").toHaveLength(0);
			await carriedRun(pi, interrupted, aborted);
			expect(pi.said, "the carried run decides").toHaveLength(1);
			expect(pi.said[0]).toMatch(FAILED_TEXT);

			// With no carried run after it, the clock still tells.
			const left = activate(killedLog(), new EventEmitter(), "s2");
			await left.fire("session_start", { reason: "startup" });
			await carriedRun(left, refused, undefined);
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(left.said, "the clock tells").toHaveLength(1);
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
			// Started and still busy, as a run reads within a turn.
			const busy = activate(killedLog(), new EventEmitter());
			await busy.fire("session_start", { reason: "startup" });
			await carriedRunStarts(busy, interrupted);
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
			busy.branch.push(aborted);
			await busy.fire("agent_settled", {});
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

	it("goes on with its wait through a reload, by the clock it had", async () => {
		// A hosted conversation reloads itself when its install moves, at
		// its first quiet moment, which a wait on a carried run is.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: [...TIMEOUTS, "Date"] });
		try {
			const pi = activate(killedLog(), new EventEmitter());
			await pi.fire("session_start", { reason: "startup" });
			const third = CARRIED_RUN_WAIT_MS / 3;
			await vi.advanceTimersByTimeAsync(2 * third);
			// A carried run that failed with no settle, read from where the
			// return began, not from where the reload found the log.
			pi.branch.push(aborted);
			await pi.fire("session_shutdown", { reason: "reload" });
			await pi.fire("session_start", { reason: "reload" });
			await vi.advanceTimersByTimeAsync(third - 1_000);
			expect(pi.said, "nothing before its clock").toHaveLength(0);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(pi.said, "told as its clock ran out").toHaveLength(1);
			expect(pi.said[0], "of the answer since its return").toMatch(FAILED_TEXT);

			// The person's words before a reload still count after it.
			const typed = activate(killedLog(), new EventEmitter(), "s2");
			await typed.fire("session_start", { reason: "startup" });
			await typed.fire("input", { text: "wait", source: "interactive" });
			await typed.fire("session_shutdown", { reason: "reload" });
			await typed.fire("session_start", { reason: "reload" });
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(typed.said, "the person was there").toHaveLength(0);

			// A reload once the wait has ended has none to go on with.
			await noticeSeen(pi);
			await pi.fire("session_shutdown", { reason: "reload" });
			await pi.fire("session_start", { reason: "reload" });
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(pi.said, "told once").toHaveLength(1);
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

	it("leaves a run stopped with no word from the person to the carried run to come, and never tells one nothing ran after", async () => {
		// A compaction stops the run and resumes it; a peer's Stop or a
		// bare Escape stops it for good, and the clock says nothing.
		const host = installTestHost();
		vi.useFakeTimers({ toFake: TIMEOUTS });
		try {
			const compacted = activate(killedLog(), new EventEmitter());
			await compacted.fire("session_start", { reason: "startup" });
			await carriedRun(compacted, interrupted, undefined, { aborted: true });
			expect(compacted.said, "a stopped run is not told").toHaveLength(0);
			await carriedRun(compacted, aborted, undefined);
			expect(compacted.said, "the resumed run decides").toHaveLength(1);
			expect(compacted.said[0]).toMatch(FAILED_TEXT);

			const stopped = activate(killedLog(), new EventEmitter(), "s2");
			await stopped.fire("session_start", { reason: "startup" });
			await carriedRun(stopped, interrupted, stoppedShort, { aborted: true });
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(stopped.said, "a run someone stopped").toHaveLength(0);

			// Stopped before a reload, and still stopped after it.
			const reloaded = activate(killedLog(), new EventEmitter(), "s3");
			await reloaded.fire("session_start", { reason: "startup" });
			await carriedRun(reloaded, interrupted, stoppedShort, { aborted: true });
			await reloaded.fire("session_shutdown", { reason: "reload" });
			await reloaded.fire("session_start", { reason: "reload" });
			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(reloaded.said, "stopped through a reload").toHaveLength(0);
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
			await stopped.fire("input", { text: "stop", source: "interactive" });
			await carriedRun(stopped, aborted, undefined, { aborted: true });

			// A host's person types over RPC, and the launcher's Steer comes
			// through an extension: words without the automated header.
			const typed = activate(killedLog(), new EventEmitter(), "s2");
			await typed.fire("session_start", { reason: "startup" });
			await typed.fire("input", { text: "Carry on", source: "rpc" });
			await carriedRun(typed, message("user"), aborted);

			const steered = activate(killedLog(), new EventEmitter(), "s3");
			await steered.fire("session_start", { reason: "startup" });
			await steered.fire("input", { text: "Carry on", source: "extension" });
			await carriedRun(steered, message("user"), aborted);

			// Joel's own steer through the inbox is framed, and still his.
			const asked = activate(killedLog(), new EventEmitter(), "s4");
			await asked.fire("session_start", { reason: "startup" });
			const his = { text: "carry on", from: "joel", file: "f" };
			const text = steerText(his, { busy: false });
			await asked.fire("input", { text, source: "extension" });
			await carriedRun(asked, message("user"), aborted);

			await vi.advanceTimersByTimeAsync(CARRIED_RUN_WAIT_MS);
			expect(
				{
					stopped: stopped.said.length,
					typed: typed.said.length,
					steered: steered.said.length,
					asked: asked.said.length,
				},
				"the person is there to say what comes next",
			).toEqual({ stopped: 0, typed: 0, steered: 0, asked: 0 });
		} finally {
			vi.useRealTimers();
			host.dispose();
		}
	});
});
