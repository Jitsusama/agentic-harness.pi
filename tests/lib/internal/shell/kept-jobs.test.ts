/**
 * What a session records of each background bash call: written private
 * and whole beside the call's files, sparing it from every reaper while
 * its shell runs within its time limit and a day, read back only for
 * its own session when its pi has gone and it can be taken up, and gone
 * with the call's other files or when taken back.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CarriedShell } from "../../../../lib/internal/shell/carried.ts";
import {
	carriedCalls,
	makeKept,
	RECORD_SPARED_FOR_MS,
	removeKept,
} from "../../../../lib/internal/shell/kept.ts";
import {
	disownKeptJob,
	forgetKeptJob,
	forgetOwnKeptJob,
	type KeptJob,
	keptJobsOf,
	recordKeptJob,
	strayKeptJobs,
} from "../../../../lib/internal/shell/kept-jobs.ts";

// What the code asks of the disk: each move and removal off the thread,
// which can be held after the disk acts, as a busy disk's callback comes
// late, or before, as a busy disk's pool gets to it late; and each
// synchronous call that could stall the thread, by the path asked.
const disk = vi.hoisted(() => {
	let held: Promise<void> | undefined;
	let release: () => void = () => undefined;
	return {
		moved: [] as string[],
		removed: [] as string[],
		asked: [] as string[],
		before: false,
		/** How many asks wait, held, for the disk to act at all. */
		parked: 0,
		hold(before = false): void {
			this.before = before;
			held = new Promise((done) => {
				release = done;
			});
		},
		go(): void {
			held = undefined;
			this.before = false;
			release();
		},
		async pass(): Promise<void> {
			if (held !== undefined) await held;
		},
		async first(): Promise<void> {
			if (!this.before) return;
			this.parked += 1;
			await this.pass();
			this.parked -= 1;
		},
		/** What was asked of `keep`'s files: moved, removed and synchronously. */
		of(keep: string): { moved: string[]; removed: string[]; asked: string[] } {
			return {
				moved: this.moved.filter((path) => path.startsWith(keep)),
				removed: this.removed.filter((path) => path.startsWith(keep)),
				asked: this.asked.filter((said) => said.includes(keep)),
			};
		},
		forget(): void {
			this.moved.length = 0;
			this.removed.length = 0;
			this.asked.length = 0;
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const rename = (async (...args: Parameters<typeof real.rename>) => {
		disk.moved.push(String(args[0]));
		await disk.first();
		await real.rename(...args);
		await disk.pass();
	}) as typeof real.rename;
	const rm = (async (...args: Parameters<typeof real.rm>) => {
		disk.removed.push(String(args[0]));
		await disk.first();
		await real.rm(...args);
		await disk.pass();
	}) as typeof real.rm;
	const mocked = { ...real, rename, rm };
	return { ...mocked, default: mocked };
});

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const rmSync = ((...args: Parameters<typeof real.rmSync>) => {
		disk.asked.push(`rmSync ${String(args[0])}`);
		return real.rmSync(...args);
	}) as typeof real.rmSync;
	const statSync = ((...args: Parameters<typeof real.statSync>) => {
		disk.asked.push(`statSync ${String(args[0])}`);
		return real.statSync(...args);
	}) as typeof real.statSync;
	const lstatSync = ((...args: Parameters<typeof real.lstatSync>) => {
		disk.asked.push(`lstatSync ${String(args[0])}`);
		return real.lstatSync(...args);
	}) as typeof real.lstatSync;
	const existsSync = ((...args: Parameters<typeof real.existsSync>) => {
		disk.asked.push(`existsSync ${String(args[0])}`);
		return real.existsSync(...args);
	}) as typeof real.existsSync;
	const mocked = { ...real, rmSync, statSync, lstatSync, existsSync };
	return { ...mocked, default: mocked };
});

const PRIVATE = 0o600;
const PRIVATE_FOLDER = 0o700;
const READ_ONLY = 0o500;
const PERMISSIONS = 0o777;

/** A shell that is there: this process, which answers as one would. */
const HERE = process.pid;

/** A pid no process has: past every kernel's highest. */
const GONE = 999_999_999;

/** How long a removal let go of is given to settle its call. */
const SETTLES_IN_MS = 5_000;

/** When the calls started, and a moment soon after. */
const STARTED = 1_000;
const SOON = 2_000;

const made: string[] = [];
afterEach(() => {
	disk.go();
	vi.restoreAllMocks();
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A folder of its own, under which the kept folder is made. */
function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), "kept-jobs-"));
	made.push(dir);
	return join(dir, "kept");
}

/** The labels of the calls recorded for `s1` in `where`, each one running. */
function labelsIn(where: string): string[] {
	return keptJobsOf("s1", where, () => true).map((one) => one.label);
}

/** What the kept folder holds, nothing staged left beside a record. */
function listed(where: string): string[] {
	return readdirSync(where);
}

/** A call kept in `where`, its shell's pid written, recorded for `session`. */
async function recorded(
	where: string,
	session: string,
	id: string,
	pid: number,
	extra: { owner?: number; deadline?: number } = {},
): Promise<KeptJob> {
	const keep = await makeKept(where);
	writeFileSync(`${keep}.pid`, `${pid}\n`);
	const work: CarriedShell = {
		kind: "shell",
		keep,
		pid,
		mark: `mark-${id}`,
		startedAt: STARTED,
		...(extra.deadline !== undefined ? { deadline: extra.deadline } : {}),
	};
	const job: KeptJob = {
		session,
		id,
		kind: "shell",
		label: `run ${id}`,
		...(extra.owner !== undefined ? { owner: extra.owner } : {}),
		work,
	};
	recordKeptJob(job);
	return job;
}

describe("a recorded job", () => {
	it("is written for its owner alone, beside the call's files", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		expect(
			statSync(`${job.work.keep}.job`).mode & PERMISSIONS,
			"the record is the owner's alone",
		).toBe(PRIVATE);
	});

	it("spares a running call from every reaper, by its group and its mark", async () => {
		const where = folder();
		await recorded(where, "s1", "j1", HERE);
		const found = carriedCalls(where, SOON);
		expect([...found.groups], "its shell's group").toEqual([HERE]);
		expect([...found.marks], "its call's mark").toEqual(["mark-j1"]);
	});

	it.each([
		["once its shell wrote how it ended", {}, HERE, true],
		["once its shell is gone", {}, GONE, false],
		["once its time limit passed", { deadline: SOON - 1 }, HERE, false],
	])("spares nothing %s", async (_case, extra, pid, ended) => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", pid, extra);
		if (ended) writeFileSync(`${job.work.keep}.end`, "0\n");
		const found = carriedCalls(where, SOON);
		expect(found.groups.size + found.marks.size, "nothing left to spare").toBe(
			0,
		);
	});

	it("spares nothing a day after its call started", async () => {
		const where = folder();
		await recorded(where, "s1", "j1", HERE);
		const found = carriedCalls(where, STARTED + RECORD_SPARED_FOR_MS);
		expect(found.groups.size + found.marks.size, "nothing left to spare").toBe(
			0,
		);
	});

	it("is read back for its own session, running or ended", async () => {
		const where = folder();
		const running = await recorded(where, "s1", "j1", 4242);
		const ended = await recorded(where, "s1", "j2", 4343);
		await recorded(where, "s2", "j3", 4444);
		writeFileSync(`${ended.work.keep}.end`, "1\n");
		const found = keptJobsOf("s1", where, (pid) => pid === 4242);
		expect(
			found.map((job) => job.id).sort(),
			"its own, the running and the ended",
		).toEqual([running.id, ended.id]);
	});

	it("is left to the pi that recorded it while that pi runs", async () => {
		const where = folder();
		await recorded(where, "s1", "j1", 4242, { owner: 77 });
		await recorded(where, "s1", "j2", 4242, { owner: 88 });
		const found = keptJobsOf(
			"s1",
			where,
			() => true,
			(pid) => pid === 77,
		);
		expect(
			found.map((job) => job.id),
			"only the one whose pi has gone",
		).toEqual(["j2"]);
		expect(listed(where).length, "the held one's files kept").toBeGreaterThan(
			0,
		);
	});

	it("goes with its call's files when its shell is gone with no status", async () => {
		const where = folder();
		await recorded(where, "s1", "j1", 4242);
		expect(
			keptJobsOf("s1", where, () => false),
			"none to take up",
		).toEqual([]);
		await vi.waitFor(() =>
			expect(listed(where), "its files removed").toEqual([]),
		);
	});

	it("goes when its call's files are removed", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", 4242);
		await removeKept(job.work.keep);
		expect(listed(where)).toEqual([]);
	});

	it("spares nothing once taken back, leaving the call's other files", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		forgetKeptJob(job.work.keep);
		const found = carriedCalls(where, SOON);
		expect(found.groups.size + found.marks.size, "nothing spared").toBe(0);
		expect(listed(where), "its pid still kept").toContain(
			`${job.work.keep.split("/").pop()}.pid`,
		);
	});

	it("never throws when what holds its name won't go", () => {
		const keep = join(folder(), "k1");
		mkdirSync(`${keep}.job`, { recursive: true });
		expect(() => forgetKeptJob(keep)).not.toThrow();
	});

	it("is passed over when it isn't one this code wrote", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", 4242);
		writeFileSync(`${job.work.keep}.job`, '{"session":"s1"}');
		expect(keptJobsOf("s1", where, () => true)).toEqual([]);
	});

	it("reads nothing before there is a folder", () => {
		expect(keptJobsOf("s1", folder(), () => true)).toEqual([]);
	});
});

// Every bash call takes back its job's record as it ends, on the loop a
// host's conversations share; most never wrote one, and asking the disk
// for a name that isn't there held that loop up to 12 s under load.
describe("a call's own record, taken back as the call ends", () => {
	it("is gone once taken back", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		await forgetOwnKeptJob(job.work.keep);
		expect(existsSync(`${job.work.keep}.job`), "its record").toBe(false);
	});

	it("asks nothing of the disk for a call this process recorded none for", async () => {
		const where = folder();
		const keep = await makeKept(where);
		writeFileSync(`${keep}.job`, "{}");
		disk.forget();
		await forgetOwnKeptJob(keep);
		expect(disk.of(keep), "nothing asked, on the thread or off it").toEqual({
			moved: [],
			removed: [],
			asked: [],
		});
		expect(
			existsSync(`${keep}.job`),
			"a record it never wrote, left unasked",
		).toBe(true);
	});

	it("is removed off the thread, once, for a call this process recorded", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.forget();
		await forgetOwnKeptJob(job.work.keep);
		expect(
			disk.of(job.work.keep),
			"set aside and removed once, none of it on the thread",
		).toEqual({
			moved: [`${job.work.keep}.job`],
			removed: [expect.stringMatching(/\.job\.\d+\.gone$/)],
			asked: [],
		});
		expect(listed(where), "nothing left beside the call").not.toContainEqual(
			expect.stringMatching(/\.gone$/),
		);
	});

	// A move or a reload hands the call on while its record goes, and the
	// one taking it up, in this process or another, writes it again.
	it("leaves the taker's record when handed on while its removal ran", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold();
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(existsSync(`${job.work.keep}.job`), "set aside").toBe(false),
		);
		disownKeptJob(job.work.keep);
		recordKeptJob({ ...job, label: "taken up" });
		disk.go();
		await going;
		expect(labelsIn(where), "the taker's record").toEqual(["taken up"]);
	});

	// The disk's pool may get to the removal only after the hand-off and the
	// taker's write, and what it does then can't be called back.
	it("leaves the taker's record when it was written before the disk got to the removal", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold(true);
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "the removal, waiting on the disk").toBe(1),
		);
		disownKeptJob(job.work.keep);
		recordKeptJob({ ...job, label: "taken up" });
		disk.go();
		await going;
		expect(labelsIn(where), "the taker's record").toEqual(["taken up"]);
		expect(listed(where), "nothing left set aside").not.toContainEqual(
			expect.stringMatching(/\.gone$/),
		);
	});

	// Handed on with nothing written yet, it is the taker's as it was.
	it("puts its record back when handed on while its removal ran", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold();
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(existsSync(`${job.work.keep}.job`), "set aside").toBe(false),
		);
		disownKeptJob(job.work.keep);
		disk.go();
		await going;
		expect(labelsIn(where), "its record, for the taker").toEqual(["run j1"]);
	});

	// A wedged disk would otherwise hold the call open with no end.
	it("lets its call settle once its wait has passed, the removal going on", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		disk.hold(true);
		const going = forgetOwnKeptJob(job.work.keep, { waitMs: 50 });
		// A bound on the wait, so one that never ends fails here, saying so,
		// rather than at the test's timeout.
		const bound = new Promise<"held">((done) =>
			setTimeout(() => done("held"), SETTLES_IN_MS),
		);
		expect(
			await Promise.race([going.then(() => "settled" as const), bound]),
			"settled while the disk still holds it",
		).toBe("settled");
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"one line saying what follows",
		).toEqual([expect.stringMatching(/may say the call's end again/)]);
		disk.go();
		await vi.waitFor(() =>
			expect(
				listed(where).filter((name) => name.includes(".job")),
				"its record, gone once the disk lets it",
			).toEqual([]),
		);
	});

	it("says a removal that took more than a second", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const clock = [0, 1_500];
		await forgetOwnKeptJob(job.work.keep, { now: () => clock.shift() ?? 0 });
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"one line, saying how long",
		).toEqual([expect.stringMatching(/took 1500 ms/)]);
	});

	// A rollover gives a running job's recorder a new key, which writes its
	// record again, maybe while the removal's callback is still to come.
	it("is taken back though written again while its removal runs", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold();
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(existsSync(`${job.work.keep}.job`), "the first removal").toBe(
				false,
			),
		);
		recordKeptJob(job);
		disk.go();
		await going;
		expect(existsSync(`${job.work.keep}.job`), "its second record").toBe(false);
	});

	it("is no longer this process's once its files went with the call's", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		await removeKept(job.work.keep);
		writeFileSync(`${job.work.keep}.job`, "{}");
		disk.forget();
		await forgetOwnKeptJob(job.work.keep);
		expect(disk.of(job.work.keep).moved, "nothing set aside").toEqual([]);
		expect(
			existsSync(`${job.work.keep}.job`),
			"a record written by another hand since",
		).toBe(true);
	});

	it("is no longer this process's once its call was handed on", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disownKeptJob(job.work.keep);
		disk.forget();
		await forgetOwnKeptJob(job.work.keep);
		expect(disk.of(job.work.keep).moved, "nothing set aside").toEqual([]);
		expect(
			existsSync(`${job.work.keep}.job`),
			"left for whoever took the call up",
		).toBe(true);
	});

	it("is never this process's when its write failed", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		await forgetOwnKeptJob(job.work.keep);
		rmSync(where, { recursive: true });
		recordKeptJob(job);
		mkdirSync(where, { recursive: true });
		writeFileSync(`${job.work.keep}.job`, "{}");
		disk.forget();
		await forgetOwnKeptJob(job.work.keep);
		expect(disk.of(job.work.keep).moved, "nothing set aside").toEqual([]);
	});

	it("is taken back again once written again", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		await forgetOwnKeptJob(job.work.keep);
		recordKeptJob(job);
		await forgetOwnKeptJob(job.work.keep);
		expect(existsSync(`${job.work.keep}.job`), "its second record").toBe(false);
	});

	it("is no longer this process's once taken back by a session's close", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		forgetKeptJob(job.work.keep);
		writeFileSync(`${job.work.keep}.job`, "{}");
		await forgetOwnKeptJob(job.work.keep);
		expect(
			existsSync(`${job.work.keep}.job`),
			"a record written by another hand since",
		).toBe(true);
	});

	// As a disk read-only after an error refuses it; root's renames pass a
	// folder's mode, so there is nothing to refuse them.
	it.skipIf(process.getuid?.() === 0)(
		"never rejects when the disk won't let it go, and says what follows",
		async () => {
			const where = folder();
			const job = await recorded(where, "s1", "j1", HERE);
			const said = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			chmodSync(where, READ_ONLY);
			try {
				await expect(forgetOwnKeptJob(job.work.keep)).resolves.toBeUndefined();
			} finally {
				// Writable again before the folder is cleared away.
				chmodSync(where, PRIVATE_FOLDER);
			}
			expect(
				said.mock.calls
					.map(([text]) => String(text))
					.filter((text) => text.includes(job.work.keep)),
				"one line naming it and what follows",
			).toEqual([expect.stringMatching(/may say the call's end again/)]);
		},
	);

	// pi loads each extension as a module copy of its own, and job-workflow
	// records the job while shell-workflow ends the call, so the two always
	// sit in different copies; a reload makes another copy again.
	it("is taken back by a copy of this code loaded after it was written", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		vi.resetModules();
		const again = await import("../../../../lib/internal/shell/kept-jobs.ts");
		await again.forgetOwnKeptJob(job.work.keep);
		expect(existsSync(`${job.work.keep}.job`), "its record").toBe(false);
	});
});

describe("a stray recorded job", () => {
	it("is one whose pi has gone and whose end isn't said", async () => {
		const where = folder();
		await recorded(where, "s1", "held", 4242, { owner: 77 });
		await recorded(where, "s1", "stray", 4242, { owner: 88 });
		const ended = await recorded(where, "s2", "ended", 4242, { owner: 88 });
		writeFileSync(`${ended.work.keep}.end`, "0\n");
		expect(
			strayKeptJobs(where, (pid) => pid === 77).map((job) => job.id),
		).toEqual(["stray"]);
	});
});
