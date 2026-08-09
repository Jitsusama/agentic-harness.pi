import { existsSync } from "node:fs";
import {
	chmod,
	mkdtemp,
	readFile,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.js";

async function tempStore(): Promise<ReviewerArtifactsStore> {
	return new ReviewerArtifactsStore(
		await mkdtemp(join(tmpdir(), "pr-reviewers-")),
	);
}

describe("ReviewerArtifactsStore", () => {
	it("keeps a run id from naming a directory above its own", async () => {
		// An id becomes a bare path segment here, so two dots are the
		// parent directory itself rather than a filename: a reviewer id
		// of `..` writes its transcripts over the run directory's
		// neighbours, and a run id of `..` writes over the store's.
		// This is the caller where the id is a bare segment; the ledger
		// appends a suffix and is safe either way, which is why the
		// guard belongs to the spelling and not to either of them.
		const store = await tempStore();

		const paths = store.paths("..", "..");

		expect(paths.runDir.startsWith(store.runsDir)).toBe(true);
		expect(paths.reviewerDir.startsWith(paths.runDir)).toBe(true);
		expect(paths.runDir).not.toContain("..");
	});

	it("builds sanitized reviewer paths under the run directory", () => {
		// Escaped rather than replaced. A map that folds two characters
		// into one is shorter to read and collides: two ids that differ
		// only where it folds share one directory, and one of them then
		// reads the other's transcripts.
		const store = new ReviewerArtifactsStore("/tmp/state");

		const paths = store.paths("run/one", "reviewer:fast");

		expect(paths.runDir).toBe("/tmp/state/runs/run~2fone");
		expect(paths.reviewerDir).toBe(
			"/tmp/state/runs/run~2fone/reviewers/reviewer~3afast",
		);
		expect(paths.resultPath).toBe(`${paths.reviewerDir}/result.json`);
	});

	it("gives two ids that differ at all two names that differ", () => {
		// The property the escaping is for, and the one a replacement
		// map cannot have. Every pair here folded together under some
		// version of this function: a slash and a dash, a leading dot
		// stripped, a leading dot substituted.
		const store = new ReviewerArtifactsStore("/tmp/state");
		const ids = ["a/b", "a-b", "a b", ".x", "x", "-x", "~x", "..", "."];

		const named = ids.map((id) => store.paths(id, "one").runDir);

		expect(new Set(named).size).toBe(ids.length);
	});

	it("clears a cancellation left by a run that used this name before", async () => {
		// A cancellation belongs to the run it stopped, and nothing ever
		// removed one. The supervisor stops the moment it sees this
		// file, so one cancelled run would poison its own name for good:
		// every later run under it would die on arrival, looking exactly
		// like a model that answered instantly and said nothing. A run
		// id repeats whenever a caller supplies one, and a job id
		// repeats by design.
		const store = await tempStore();
		await store.requestReviewerCancellation("run", "one", "startup-stale");

		const paths = await store.ensureReviewerDir("run", "one");

		expect(existsSync(paths.cancelPath)).toBe(false);
	});

	it("clears a run-wide cancellation when the run begins again", async () => {
		// The supervisor polls both sentinels on the same tick, so
		// clearing only the per-reviewer one leaves the run-wide one to
		// kill every later run under this id on arrival. Cleared once for
		// the run rather than in `ensureReviewerDir`, because a run's
		// later jobs are prepared while its earlier ones are running and
		// doing it there would erase a cancellation that had just landed.
		const store = await tempStore();
		await store.requestRunCancellation("run", "user");

		await store.beginRun("run");

		expect(existsSync(store.rootPaths("run").cancelPath)).toBe(false);
	});

	it("writes JSON atomically and reads it back", async () => {
		const store = await tempStore();
		const path = store.paths("run", "fast").resultPath;

		await store.writeJsonAtomic(path, { ok: true });

		expect(await store.readJson(path)).toEqual({ ok: true });
	});

	it("appends only while the capped artifact stays under its limit", async () => {
		const store = await tempStore();
		const path = join(store.stateDir, "events.ndjson");

		expect(await store.appendCapped(path, Buffer.from("abc"), 5)).toMatchObject(
			{
				written: true,
				limitExceeded: false,
			},
		);
		expect(await store.appendCapped(path, Buffer.from("def"), 5)).toMatchObject(
			{
				written: false,
				limitExceeded: true,
			},
		);
		expect(await readFile(path, "utf-8")).toBe("abc");
	});

	it("cleans up old terminal runs without deleting active ones", async () => {
		const store = await tempStore();
		const terminal = store.paths("old", "fast");
		const active = store.paths("active", "fast");
		await store.writeJsonAtomic(terminal.resultPath, { ok: true });
		await store.writeJsonAtomic(active.progressPath, { state: "running" });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: -1,
			maxRuns: 0,
			now: new Date(),
		});

		expect(result.removed).toBe(1);
		await expect(stat(terminal.runDir)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect((await stat(active.runDir)).isDirectory()).toBe(true);
	});

	it("takes a finished run that is too old, however few there are", async () => {
		// The two ordinary windows separately, because the sweep that
		// covered them together set both to fire at once and either alone
		// would have passed it. Room for a hundred runs and one run in
		// the directory, so only age can be doing this.
		const store = await tempStore();
		const stale = store.paths("stale", "fast");
		await store.writeJsonAtomic(stale.resultPath, { ok: true });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: -1,
			maxRuns: 100,
			now: new Date(),
		});

		expect(result.removed).toBe(1);
		await expect(stat(stale.runDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("takes the oldest finished runs past the count, however fresh", async () => {
		// The other half. An age window nothing can exceed, so only the
		// count can be doing this, and it has to fall on the older of the
		// two rather than on whichever the directory happened to list
		// first.
		const store = await tempStore();
		const older = store.paths("older", "fast");
		const newer = store.paths("newer", "fast");
		await store.writeJsonAtomic(older.resultPath, { ok: true });
		await utimes(older.runDir, new Date(), new Date(Date.now() - 60_000));
		await store.writeJsonAtomic(newer.resultPath, { ok: true });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: Number.POSITIVE_INFINITY,
			maxRuns: 1,
			now: new Date(),
		});

		expect(result.removed).toBe(1);
		expect((await stat(newer.runDir)).isDirectory()).toBe(true);
		await expect(stat(older.runDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("reclaims the rest when one run cannot be walked", async () => {
		// The terminal check is asked for every run before any run is
		// judged, so that the count can rank a run among the ones the
		// count may take. That hoist put a rethrow ahead of the whole
		// sweep: before it, everything ranked ahead of a bad directory had
		// already been reclaimed, and after it one directory the process
		// cannot enter meant zero bytes back, every session, until
		// somebody fixed it by hand.
		const store = await tempStore();
		const shut = store.paths("shut", "fast");
		const ordinary = store.paths("ordinary", "fast");
		await store.writeJsonAtomic(shut.resultPath, { ok: true });
		await store.writeJsonAtomic(ordinary.resultPath, { ok: true });
		await chmod(shut.runDir, 0o000);

		try {
			const result = await store.cleanupTerminalRuns({
				maxAgeMs: -1,
				maxRuns: 0,
				now: new Date(),
			});

			await expect(stat(ordinary.runDir)).rejects.toMatchObject({
				code: "ENOENT",
			});
			// Held rather than taken, since a run that cannot be asked
			// whether it finished gets the careful answer, and said rather
			// than decided quietly.
			expect((await stat(shut.runDir)).isDirectory()).toBe(true);
			expect(result.warnings.join(" ")).toContain(shut.runDir);
		} finally {
			await chmod(shut.runDir, 0o700);
		}
	});

	it("counts what protection is holding, apart from what is merely kept", async () => {
		// Nothing else can tell a person this. Protection is absolute, so
		// it is the only population here that grows without a limit, and a
		// protected round is by definition one nobody has collected, so no
		// listing they read is going to mention it.
		//
		// Counted plainly rather than as "how many protection is costing".
		// Working that out means asking what would have happened without
		// the protection, and the answer turns on whether the run
		// finished, which is the question protection skips: guessing
		// "finished" counted every unfinished protected run three weeks
		// before its own window, and still could not see a hundred fresh
		// protected runs, which is the case that actually runs away.
		const store = await tempStore();
		const waiting = store.paths("waiting", "fast");
		const dispatched = store.paths("dispatched", "fast");
		const justRan = store.paths("just-ran", "fast");
		await store.writeJsonAtomic(waiting.resultPath, { ok: true });
		await store.writeJsonAtomic(dispatched.progressPath, { state: "running" });
		await store.writeJsonAtomic(justRan.resultPath, { ok: true });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: Number.POSITIVE_INFINITY,
			maxRuns: 100,
			abandonedAfterMs: Number.POSITIVE_INFINITY,
			protect: new Set(["waiting", "dispatched"]),
			now: new Date(),
		});

		// All three kept, and the two nothing may take counted apart from
		// the one that is merely recent, whether or not they finished.
		expect(result.kept).toBe(3);
		expect(result.held).toBe(2);
	});

	it("reports a run it decided to take and could not", async () => {
		// Two callers print this array now, and nothing showed it could
		// ever hold anything: a summary that is always empty reads the
		// same as a sweep that always works. A directory the process
		// cannot write is how a delete fails in the field, and the point
		// of saying so is that the alternative is finding out from the
		// disk.
		const store = await tempStore();
		const stuck = store.paths("stuck", "fast");
		await store.writeJsonAtomic(stuck.resultPath, { ok: true });
		const parent = dirname(stuck.runDir);
		await chmod(parent, 0o500);

		try {
			const result = await store.cleanupTerminalRuns({
				maxAgeMs: -1,
				maxRuns: 0,
				now: new Date(),
			});

			expect(result.removed).toBe(0);
			expect(result.warnings).toHaveLength(1);
			// Naming the directory, since a reader with several rounds on
			// disk needs to know which one is stuck.
			expect(result.warnings[0]).toContain(stuck.runDir);
		} finally {
			await chmod(parent, 0o700);
		}
	});

	it("keeps a protected run past every window there is", async () => {
		// No clock takes a protected run, including the long one, and this
		// is the case that says so rather than leaving it to be inferred
		// from a policy that omits the window. A round detached from its
		// session writes what its reviewers said nowhere but here until
		// somebody collects it, so a sweep taking one on a timer deletes
		// the findings and leaves the ledger entry advertising them.
		//
		// This was briefly the other way. Nothing but a person bounds
		// these, which is the honest answer: every listing reports the
		// round as unsettled until it is collected or closed.
		const store = await tempStore();
		const unfinished = store.paths("uncollected-unfinished", "fast");
		const finished = store.paths("uncollected-finished", "fast");
		await store.writeJsonAtomic(unfinished.progressPath, { state: "running" });
		await store.writeJsonAtomic(finished.resultPath, { ok: true });

		const result = await store.cleanupTerminalRuns({
			// Every window set to take everything it is allowed to take.
			maxAgeMs: -1,
			maxRuns: 0,
			abandonedAfterMs: -1,
			protect: new Set(["uncollected-unfinished", "uncollected-finished"]),
			now: new Date(),
		});

		expect(result.removed).toBe(0);
		expect((await stat(unfinished.runDir)).isDirectory()).toBe(true);
		expect((await stat(finished.runDir)).isDirectory()).toBe(true);
	});

	it("protects a run whose id is not its directory name", async () => {
		// The set comes from a caller's ledger and holds run ids; the
		// names here have been through safeSegment. Every id this package
		// mints today is already a safe segment, so the two coincide and
		// a mismatch would not crash: the lookup misses, the round loses
		// its protection, and reviews somebody paid for are deleted
		// quietly. That is the one failure protection exists to prevent.
		const store = await tempStore();
		const awkward = store.paths("council:2026/07", "fast");
		await store.writeJsonAtomic(awkward.resultPath, { ok: true });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: -1,
			maxRuns: 0,
			protect: new Set(["council:2026/07"]),
			now: new Date(),
		});

		expect(result.removed).toBe(0);
		expect((await stat(awkward.runDir)).isDirectory()).toBe(true);
	});

	it("does not let kept runs spend the count on behalf of finished ones", async () => {
		// The count ranks a run among the runs the count may take. Ranking
		// it among every directory lets runs that can never be evicted
		// fill the budget and push out ones that can, and the runs that
		// cannot be evicted are the recent ones, so a fresh finished round
		// goes while a stale protected one stays.
		const store = await tempStore();
		const open = store.paths("still-open", "fast");
		const running = store.paths("still-running", "fast");
		const done = store.paths("finished", "fast");
		await store.writeJsonAtomic(done.resultPath, { ok: true });
		await utimes(done.runDir, new Date(), new Date(Date.now() - 60_000));
		await store.writeJsonAtomic(open.resultPath, { ok: true });
		await store.writeJsonAtomic(running.progressPath, { state: "running" });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: Number.POSITIVE_INFINITY,
			// Room for one, and the finished run is the only candidate, so
			// it is the one the room is for.
			maxRuns: 1,
			abandonedAfterMs: Number.POSITIVE_INFINITY,
			protect: new Set(["still-open"]),
			now: new Date(),
		});

		expect(result.removed).toBe(0);
		expect((await stat(done.runDir)).isDirectory()).toBe(true);
	});

	it("keeps a protected run the ordinary windows would take", async () => {
		// A round detached from its session writes every result file and
		// then waits to be collected, so to this sweep it is a finished
		// round nobody needs. Deleting it throws away reviews that have
		// been paid for and leaves a ledger entry pointing at nothing.
		const store = await tempStore();
		const waiting = store.paths("uncollected", "fast");
		const finished = store.paths("collected", "fast");
		await store.writeJsonAtomic(waiting.resultPath, { ok: true });
		await store.writeJsonAtomic(finished.resultPath, { ok: true });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: -1,
			maxRuns: 0,
			protect: new Set(["uncollected"]),
			now: new Date(),
		});

		expect(result.removed).toBe(1);
		expect((await stat(waiting.runDir)).isDirectory()).toBe(true);
		await expect(stat(finished.runDir)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("reclaims a run abandoned long enough that recovery is moot", async () => {
		// A run killed before its reviewer wrote a result is never
		// terminal, so the terminal-only rule can never reclaim it and it
		// lives forever. Two such runs, 24 and 28 days old, were found on
		// disk after a month of use.
		const store = await tempStore();
		const abandoned = store.paths("abandoned", "fast");
		await store.writeJsonAtomic(abandoned.progressPath, { state: "running" });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: 60_000,
			maxRuns: 100,
			abandonedAfterMs: -1,
			now: new Date(),
		});

		expect(result.removed).toBe(1);
		await expect(stat(abandoned.runDir)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("keeps an unfinished run while recovery is still plausible", async () => {
		// The reason the abandoned window is separate from the terminal
		// one: a run that is merely in progress must survive a cleanup
		// that is aggressive about finished ones.
		const store = await tempStore();
		const active = store.paths("active", "fast");
		await store.writeJsonAtomic(active.progressPath, { state: "running" });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: -1,
			maxRuns: 0,
			abandonedAfterMs: 60_000,
			now: new Date(),
		});

		expect(result.removed).toBe(0);
		expect((await stat(active.runDir)).isDirectory()).toBe(true);
	});

	it("leaves unfinished runs alone when no abandoned window is set", async () => {
		// The policy predates the window, so an omitted one has to mean
		// "never reclaim an unfinished run" rather than "reclaim it now".
		const store = await tempStore();
		const active = store.paths("active", "fast");
		await store.writeJsonAtomic(active.progressPath, { state: "running" });

		const result = await store.cleanupTerminalRuns({
			maxAgeMs: -1,
			maxRuns: 0,
			now: new Date(),
		});

		expect(result.removed).toBe(0);
	});

	it("writes run and reviewer cancellation requests", async () => {
		const store = await tempStore();

		await store.requestRunCancellation("run", "user");
		await store.requestReviewerCancellation("run", "fast", "user");

		expect(
			await store.readJson(store.rootPaths("run").cancelPath),
		).toMatchObject({
			reason: "user",
		});
		expect(
			await store.readJson(store.paths("run", "fast").cancelPath),
		).toMatchObject({
			reason: "user",
		});
	});

	it("overwrites existing JSON through the atomic path", async () => {
		const store = await tempStore();
		const path = (await store.ensureReviewerDir("run", "fast")).leasePath;
		await writeFile(path, '{"state":"old"}\n');

		await store.writeJsonAtomic(path, { state: "new" });

		expect(await store.readJson(path)).toEqual({ state: "new" });
	});
});
