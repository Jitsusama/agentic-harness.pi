/**
 * A fleet child whose supervisor died is stopped at the next session
 * start that looks for it.
 *
 * A supervisor that is itself killed leaves a child nothing can reach,
 * because the pid was only ever known to the process that died. The
 * lease it wrote is what lets a later session find it, ask it to stop,
 * and kill it when the lease names it exactly.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createFleetLedger } from "../../../lib/subagent/fleet.ts";
import { ReviewerArtifactsStore } from "../../../lib/subagent/index.ts";
import { systemFacts } from "../../../lib/subagent/lease.ts";
import { noSuchProcess } from "../../support/processes.ts";
import {
	alsoOrphaned,
	DAY_MS,
	finished,
	holdFleetState,
	holdTheClock,
	orphaned,
	said,
	staleFleet,
	startSession,
	stateDir,
} from "./fleet-session.ts";

// A state directory of its own, and a screen whose notices are kept.
holdFleetState();

describe("a fleet child whose supervisor died", () => {
	it("is asked to stop at the next session start", async () => {
		// The one orphan a fleet can actually have. A supervisor whose
		// session goes stops its own child within half a second, so a
		// dead session leaves nothing running; a supervisor that is
		// itself killed leaves a child nothing can reach, because the
		// pid was only ever known to the process that died.
		//
		// Nothing is signalled here: the lease names processes that are
		// already gone, so what is asserted is the request to stop
		// rather than a kill. A test that reaps for real is a test that
		// kills something by a number it read off disk.
		const store = new ReviewerArtifactsStore(stateDir());
		const paths = await store.ensureReviewerDir("fleet-orphaned", "one");
		await store.writeJsonAtomic(paths.progressPath, {
			state: "running",
			activity: "thinking",
			updatedAt: new Date().toISOString(),
		});
		await store.writeJsonAtomic(paths.leasePath, {
			state: "running",
			supervisorPid: noSuchProcess(),
			supervisorStartedAt: 1_000_000,
			updatedAt: new Date().toISOString(),
		});

		await startSession();

		await vi.waitFor(() =>
			expect(
				existsSync(paths.cancelPath),
				`${paths.cancelPath} is written`,
			).toBe(true),
		);
	});

	it("kills it, and says so, when the lease names it exactly", async () => {
		// The whole path, against a real process, because this is the
		// one that spends money when it is broken: an orphan holding a
		// large model runs to a backstop measured in hours.
		//
		// A test that reaps for real is a test that kills something by a
		// number it read off disk, which is why the rest of these avoid
		// it. This one is safe on both counts: the process is one the
		// test spawned, and it is spawned detached so it leads its own
		// group, which is what the reaper signals.
		const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
			detached: true,
			stdio: "ignore",
		});
		const pid = child.pid;
		if (pid === undefined) throw new Error("the child never got a pid");
		child.unref();
		try {
			const store = new ReviewerArtifactsStore(stateDir());
			const paths = await store.ensureReviewerDir("fleet-holding", "one");
			await store.writeJsonAtomic(paths.progressPath, {
				state: "running",
				activity: "thinking",
				updatedAt: new Date().toISOString(),
			});
			await store.writeJsonAtomic(paths.leasePath, {
				state: "running",
				supervisorPid: noSuchProcess(),
				supervisorStartedAt: 1_000_000,
				childPid: pid,
				// Read from the machine rather than guessed. The reaper
				// compares the lease against a fresh observation and
				// refuses on a mismatch, and `ps` reports whole seconds,
				// so a timestamp taken here would sometimes differ.
				childStartedAt: await systemFacts.startedAt(pid),
				updatedAt: new Date().toISOString(),
			});

			await startSession();

			// A budget rather than the default second: this path sleeps
			// half a second between the two signals by design, and forks
			// `ps` twice around it, so the default leaves nothing for a
			// loaded machine and fails as a flake rather than a finding.
			await vi.waitFor(
				() => expect(said.join(" ")).toContain("fleet-holding/one"),
				{ timeout: 30_000 },
			);
			// Both halves. Asking is what happened to every stale run;
			// killing is what happened to the subset still holding on, and
			// a message reporting only the second says nothing at all
			// about the ordinary case where the child had already gone.
			expect(said.join(" ")).toContain("asked 1 subagent");
			expect(said.join(" ")).toContain("killed 1 child");
			await vi.waitFor(
				() =>
					expect(systemFacts.alive(pid), `process ${pid} is killed`).toBe(
						false,
					),
				{ timeout: 30_000 },
			);
		} finally {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone, which is the outcome the test wanted.
			}
		}
		// The budget belongs on the case as well as on the waits inside
		// it. This path sleeps half a second between its two signals by
		// design and forks `ps` around them, and thirty seconds given to
		// a `vi.waitFor` inside a case vitest ends at five is a number
		// that reads as generous and is never reached.
	}, 60_000);

	it("leaves a fleet whose supervisor is still there", async () => {
		// The other side, and the one that costs money to get wrong: a
		// concurrent session's fleet is running, and cancelling it
		// throws away work somebody is waiting for. This process is the
		// live supervisor, since it is the one process the test can
		// prove is alive.
		const store = new ReviewerArtifactsStore(stateDir());
		const paths = await store.ensureReviewerDir("fleet-running", "one");
		await store.writeJsonAtomic(paths.progressPath, {
			state: "running",
			activity: "thinking",
			updatedAt: new Date().toISOString(),
		});
		await store.writeJsonAtomic(paths.leasePath, {
			state: "running",
			supervisorPid: process.pid,
			updatedAt: new Date().toISOString(),
		});

		// Something the recovery must act on, so the absence below is an
		// observation rather than a race. The first version of this case
		// waited on `said.join(" ")).not.toBe(undefined)`, which is true
		// of the empty string, so it asserted against a session start
		// that had not begun.
		await alsoOrphaned(store);

		await startSession();

		await finished();
		expect(
			existsSync(paths.cancelPath),
			`${paths.cancelPath} is not written`,
		).toBe(false);
	});

	it("is looked for by the first session start in a window, not by every one", async () => {
		// A restart reopens every session at once and an install reloads
		// every one, and each look walks every run ever kept. The first
		// start in a window looks for the whole machine.
		const opens = holdTheClock();
		const store = new ReviewerArtifactsStore(stateDir());
		await alsoOrphaned(store);
		await startSession();
		await finished();

		// Left after that look. The next start in the window is seen to
		// be done when it tells its conversation of a fleet cut off.
		await orphaned(store, "fleet-later");
		await createFleetLedger(stateDir("fleets")).open({
			id: "fleet-0",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
			session: "conversation-a",
			owner: { pid: noSuchProcess(), startedAt: 1_000 },
		});
		staleFleet("fleet-0");
		vi.setSystemTime(opens + 60_000);
		const second = await startSession("conversation-a");
		await vi.waitFor(() => expect(second).toHaveLength(1));

		// The next window's first start finds it, so nobody had before:
		// a run is named only by the first look that finds it.
		await orphaned(store, "zz-third");
		vi.setSystemTime(opens + DAY_MS);
		await startSession();
		await vi.waitFor(() => expect(said.join(" ")).toContain("zz-third/one"), {
			timeout: 30_000,
		});
		expect(said.filter((line) => line.includes("fleet-later/one"))).toEqual([
			expect.stringContaining("zz-third/one"),
		]);
	});

	it("leaves a job that has not written its lease yet", async () => {
		// The window every run passes through: the directory is there
		// and the lease is not, because the supervisor writes the lease
		// before it spawns anything. Read as "supervisor gone", a
		// session starting in that moment cancels a fleet another
		// session dispatched a heartbeat earlier.
		const store = new ReviewerArtifactsStore(stateDir());
		const paths = await store.ensureReviewerDir("fleet-starting", "one");
		await alsoOrphaned(store);

		await startSession();

		await finished();
		expect(
			existsSync(paths.cancelPath),
			`${paths.cancelPath} is not written`,
		).toBe(false);
	});
});
