/**
 * A fleet's transcripts are not reclaimed while nobody has read them.
 *
 * A fleet's answers exist in two places: the tool result handed to
 * the session that asked, and the transcripts on disk. When the
 * session dies mid-fleet the first never happens, so the second is
 * the only copy, and until the ledger existed nothing said so: the
 * sweep saw run directories of the ordinary age and took them.
 *
 * The review side learned this the expensive way, over five councils
 * and a first fix that was backwards. Everything here is the same
 * argument one layer down, so the cases are deliberately the same
 * cases.
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentWorkflow from "../../../extensions/subagent-workflow/index.js";
import { createFleetLedger } from "../../../lib/subagent/fleet.js";
import { ReviewerArtifactsStore } from "../../../lib/subagent/index.js";
import { systemFacts } from "../../../lib/subagent/lease.js";
import { noSuchProcess } from "../../support/processes.js";
import { activateWith } from "../support/review-extension.js";

let root: string;
let said: string[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fleet-sweep-"));
	// The extension resolves its state directory from the environment
	// on every call, which is what makes it redirectable at all.
	vi.stubEnv("XDG_STATE_HOME", root);
	said = [];
	vi.spyOn(console, "error").mockImplementation((line: unknown) => {
		said.push(String(line));
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** Where the extension keeps its subagent state. */
function stateDir(...parts: string[]): string {
	return join(root, "pi", "agentic-harness.pi", "subagent-workflow", ...parts);
}

/** A finished fleet's transcripts, old enough for the ordinary window. */
function staleFleet(id: string): string {
	const paths = new ReviewerArtifactsStore(stateDir()).paths(id, "one");
	mkdirSync(join(paths.resultPath, ".."), { recursive: true });
	writeFileSync(paths.resultPath, JSON.stringify({ ok: true }), "utf8");
	// Aged by the caller rather than here, because writing the result
	// file above moves the run directory's mtime and this would then
	// be aging a directory that is about to look new again.
	return paths.runDir;
}

/**
 * A run the housekeeping must act on, so absence can be observed.
 *
 * Every case that asserts something did not happen needs a moment
 * that is definitely after the decision it denies, and there is no
 * such moment inside the thing being denied. This is one: its
 * supervisor is plainly gone, so it is acted on and announced, and
 * that announcement comes after every run has been decided and after
 * the sweep that runs before them.
 */
async function alsoOrphaned(store: ReviewerArtifactsStore): Promise<void> {
	const paths = await store.ensureReviewerDir("zz-orphan", "one");
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
}

/** Wait until the housekeeping has said what it did. */
async function finished(): Promise<void> {
	await vi.waitFor(() => expect(said.join(" ")).toContain("zz-orphan/one"), {
		timeout: 30_000,
	});
}

/** Age a path past every ordinary window. */
async function age(path: string): Promise<void> {
	const long = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	await utimes(path, long, long);
}

/** Start the session the way pi starts one. */
async function startSession(): Promise<void> {
	const started = activateWith(subagentWorkflow).lifecycle.get("session_start");
	if (started === undefined) {
		throw new Error("the extension registered no session_start on pi.on");
	}
	await started({ reason: "startup" }, {});
}

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

		await vi.waitFor(() => expect(existsSync(paths.cancelPath)).toBe(true));
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
			await vi.waitFor(() => expect(systemFacts.alive(pid)).toBe(false), {
				timeout: 30_000,
			});
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
		expect(existsSync(paths.cancelPath)).toBe(false);
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
		expect(existsSync(paths.cancelPath)).toBe(false);
	});
});

describe("the fleet retention sweep", () => {
	it("reclaims a fleet somebody has been handed", async () => {
		// The other side of everything below. Without it a sweep that
		// never ran would pass every case here, since one that deletes
		// nothing also destroys nothing.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-done",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
		});
		await ledger.settle("fleet-done");
		const transcripts = staleFleet("fleet-done");
		await age(transcripts);

		await startSession();

		await vi.waitFor(() => expect(existsSync(transcripts)).toBe(false));
	});

	it("keeps a fleet nobody has collected, however old", async () => {
		// The one that matters. An open fleet is one whose session did
		// not live to hand it back, so these transcripts are the only
		// copy of what was paid for, and no clock makes that untrue.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-orphan",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
		});
		const transcripts = staleFleet("fleet-orphan");
		await age(transcripts);

		await startSession();

		// Waited on the other one going, so this is not merely a sweep
		// that had not started yet.
		const other = staleFleet("fleet-nobody-recorded");
		await age(other);
		await startSession();
		await vi.waitFor(() => expect(existsSync(other)).toBe(false));
		expect(existsSync(transcripts)).toBe(true);
	});

	it("forgets a settled record once its transcripts have gone", async () => {
		// The seam that makes the ledger's own window real. Without the
		// call, `fleets/` is the unbounded thing the ledger was built to
		// bound: one small file per fleet ever dispatched, all of them
		// read at every session start, long after what they point at
		// has been reclaimed.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-ancient",
			startedAt: "2019-01-01T00:00:00.000Z",
			jobs: ["one"],
		});
		await ledger.settle("fleet-ancient");
		const record = join(stateDir("fleets"), "fleet-ancient.json");
		const old = JSON.parse(readFileSync(record, "utf8"));
		writeFileSync(
			record,
			JSON.stringify({ ...old, settledAt: "2019-01-01T00:00:00.000Z" }),
			"utf8",
		);

		await startSession();

		await vi.waitFor(() => expect(existsSync(record)).toBe(false));
	});

	it("declines the sweep when the fleet ledger will not read", async () => {
		// An empty protect set is not the cautious reading of a ledger
		// that will not open, it is the destructive one: every fleet
		// that finished on disk then looks like one nobody needs.
		mkdirSync(stateDir("fleets"), { recursive: true });
		writeFileSync(stateDir("fleets", "torn.json"), "{ not json", "utf8");
		const transcripts = staleFleet("fleet-done");
		await age(transcripts);

		await startSession();

		await vi.waitFor(() => {
			const about = said.filter((line) => line.includes("will not be swept"));
			expect(about).toHaveLength(1);
			expect(about[0]).toContain("torn.json");
			expect(about[0]).toContain("every session");
		});
		expect(existsSync(transcripts)).toBe(true);
	});

	it("says how many fleets are being held once there are enough to matter", async () => {
		// Protection is absolute, so this is the population that can
		// grow without a limit, and nothing else would ever mention it:
		// a fleet nobody collected is by definition one nobody knows
		// about.
		//
		// Counted from what the sweep held rather than from what the
		// ledger says, so each of these has transcripts on disk. The two
		// numbers are not the same: a fleet can be open on the ledger
		// with nothing behind it at all, and a message announcing
		// megabytes that are not there sends somebody looking for a
		// directory that does not exist.
		// Three abandoned among five held, so the two numbers differ.
		// Five and five cannot tell them apart, and they are different
		// populations: what the sweep held includes fleets another
		// session is running right now, which must not be offered up.
		const ledger = createFleetLedger(stateDir("fleets"));
		const dead = noSuchProcess();
		const mine = await systemFacts.startedAt(process.pid);
		if (mine === undefined) throw new Error("the machine would not say");
		for (let n = 0; n < 5; n++) {
			await ledger.open({
				id: `fleet-${n}`,
				startedAt: new Date().toISOString(),
				jobs: ["one"],
				owner:
					n < 3
						? { pid: dead, startedAt: 1_000 }
						: { pid: process.pid, startedAt: mine },
			});
			await age(staleFleet(`fleet-${n}`));
		}

		await startSession();

		await vi.waitFor(() => {
			const about = said.filter((line) => line.includes("never came back"));
			expect(about).toHaveLength(1);
			expect(about[0]).toContain("3 fleets of the 5");
			// Named, so somebody can act on one rather than on the count.
			// The two still running are not named, since the only lever
			// offered here would unprotect them.
			expect(about[0]).toContain("fleet-0, fleet-1, fleet-2");
			expect(about[0]).not.toContain("fleet-3");
			// Where they are, and how to let one go. Announcing an
			// unbounded population that nothing in the product can
			// release, without saying what releases it, is a nag with no
			// answer.
			expect(about[0]).toContain(stateDir("runs"));
			expect(about[0]).toContain(stateDir("fleets"));
		});
	});

	it("says nothing about a held fleet another session is running", async () => {
		// The case the count alone could not see, and the one where
		// speaking does harm: these transcripts are held because work is
		// in flight, and the only lever the message offers would
		// unprotect it. This process stands in for the live session,
		// since it is the one this test can prove is alive.
		const ledger = createFleetLedger(stateDir("fleets"));
		const mine = await systemFacts.startedAt(process.pid);
		if (mine === undefined) throw new Error("the machine would not say");
		for (let n = 0; n < 5; n++) {
			await ledger.open({
				id: `fleet-${n}`,
				startedAt: new Date().toISOString(),
				jobs: ["one"],
				owner: { pid: process.pid, startedAt: mine },
			});
			await age(staleFleet(`fleet-${n}`));
		}

		// Anchored to something that happens strictly after the decision
		// being denied. Waiting for the sweep to delete something is not
		// that, since the sweep runs before this message is considered.
		await alsoOrphaned(new ReviewerArtifactsStore(stateDir()));

		await startSession();

		await finished();
		expect(said.filter((line) => line.includes("never came back"))).toEqual([]);
	});

	it("says nothing about fleets the ledger holds but the disk does not", async () => {
		// The other half of counting what was held. Five open records
		// with no transcripts behind them is five fleets whose
		// dispatches never got as far as writing anything, and there is
		// nothing there to go and look at.
		const ledger = createFleetLedger(stateDir("fleets"));
		for (let n = 0; n < 5; n++) {
			await ledger.open({
				id: `fleet-${n}`,
				startedAt: new Date().toISOString(),
				jobs: ["one"],
			});
		}

		await startSession();

		const transcripts = staleFleet("fleet-swept");
		await age(transcripts);
		await startSession();
		await vi.waitFor(() => expect(existsSync(transcripts)).toBe(false));
		expect(said).toEqual([]);
	});

	it("says nothing while only a few are held", async () => {
		// A channel that speaks every session is a channel nobody reads,
		// and a couple of held fleets is the ordinary state of a machine
		// somebody used this morning.
		//
		// Four, not zero. Holding none would pin the threshold only from
		// above, so a version that spoke at one would pass this and the
		// case below it alike.
		const ledger = createFleetLedger(stateDir("fleets"));
		for (let n = 0; n < 4; n++) {
			await ledger.open({
				id: `fleet-${n}`,
				startedAt: new Date().toISOString(),
				jobs: ["one"],
			});
			await age(staleFleet(`fleet-${n}`));
		}
		const transcripts = staleFleet("fleet-swept");
		await age(transcripts);

		await startSession();

		await vi.waitFor(() => expect(existsSync(transcripts)).toBe(false));
		expect(said).toEqual([]);
	});
});
