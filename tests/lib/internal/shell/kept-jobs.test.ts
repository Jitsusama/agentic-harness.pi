/**
 * What a session records of each background bash call: written private
 * and whole beside the call's files, sparing it from every reaper while
 * its shell runs within its time limit and a day, read back only for
 * its own session when its pi has gone and it can be taken up, and gone
 * with the call's other files or when taken back. Long because each
 * case of taking a record back is one more way the disk can stand as it
 * goes, held and refused through the one disk stand-in at the top, which
 * a split would copy into every file.
 */

import { getEventListeners } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRecord } from "../../../../lib/internal/record.ts";
import type { CarriedShell } from "../../../../lib/internal/shell/carried.ts";
import {
	carriedCalls,
	makeKept,
	markCarried,
	RECORD_SPARED_FOR_MS,
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
import {
	ownJobRecord,
	removeKept,
} from "../../../../lib/internal/shell/kept-removal.ts";

// What the code asks of the disk: each move, link, write and removal off
// the thread, which can be held after the disk acts, as a busy disk's
// callback comes late, or before, as a busy disk's pool gets to it late,
// either for every kind of ask or only one, on every path or only those
// matching, and can be refused, as a failing disk refuses it or as a
// name taken already does; and each other call that asks after a file,
// every synchronous one, which could stall the thread, and the stats,
// reads, opens and unlinks off it, by the path asked.
type Ask = "rename" | "rm" | "link" | "writeFile";
const disk = vi.hoisted(() => {
	let held: Promise<void> | undefined;
	let release: () => void = () => undefined;
	return {
		moved: [] as string[],
		removed: [] as string[],
		asked: [] as string[],
		/** Each rename and link the disk has acted on, done or refused, as `ask path`. */
		acted: [] as string[],
		/** Run as each rename is asked, before the disk acts on it. */
		onRename: undefined as ((path: string) => void) | undefined,
		before: false,
		only: undefined as Ask | undefined,
		on: undefined as RegExp | undefined,
		refused: undefined as Ask | undefined,
		/** What a refusal says: a failing disk's EIO unless set. */
		refusal: "EIO",
		/** Whether another hand takes each staged name as it is written. */
		takesStaged: false,
		/** How many asks wait, held, for the disk to act at all. */
		parked: 0,
		/** Those asks, each as `ask path`. */
		waiting: [] as string[],
		hold(before = false, only?: Ask, on?: RegExp): void {
			this.before = before;
			this.only = only;
			this.on = on;
			held = new Promise((done) => {
				release = done;
			});
		},
		go(): void {
			held = undefined;
			this.before = false;
			this.only = undefined;
			this.on = undefined;
			release();
		},
		holds(ask: Ask, path: string): boolean {
			return (
				held !== undefined &&
				(this.only ?? ask) === ask &&
				(this.on?.test(path) ?? true)
			);
		},
		async pass(ask: Ask, path: string): Promise<void> {
			if (this.holds(ask, path)) await held;
		},
		async first(ask: Ask, path: string): Promise<void> {
			if (!this.before || !this.holds(ask, path)) return;
			const asked = `${ask} ${path}`;
			this.parked += 1;
			this.waiting.push(asked);
			await held;
			this.parked -= 1;
			this.waiting.splice(this.waiting.indexOf(asked), 1);
		},
		/** Refuse `path` as `refusal` says, when `ask` is refused. */
		refuse(ask: Ask, path: string): void {
			if (this.refused !== ask) return;
			throw Object.assign(
				new Error(`${this.refusal}: refused, ${ask} '${path}'`),
				{ code: this.refusal },
			);
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
			this.acted.length = 0;
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const rename = (async (...args: Parameters<typeof real.rename>) => {
		const path = String(args[0]);
		disk.moved.push(path);
		disk.onRename?.(path);
		await disk.first("rename", path);
		try {
			disk.refuse("rename", path);
			await real.rename(...args);
		} finally {
			disk.acted.push(`rename ${path}`);
		}
		await disk.pass("rename", path);
	}) as typeof real.rename;
	const rm = (async (...args: Parameters<typeof real.rm>) => {
		const path = String(args[0]);
		disk.removed.push(path);
		await disk.first("rm", path);
		disk.refuse("rm", path);
		await real.rm(...args);
		await disk.pass("rm", path);
	}) as typeof real.rm;
	const link = (async (...args: Parameters<typeof real.link>) => {
		const path = String(args[1]);
		await disk.first("link", path);
		try {
			disk.refuse("link", path);
			await real.link(...args);
		} finally {
			disk.acted.push(`link ${path}`);
		}
		await disk.pass("link", path);
	}) as typeof real.link;
	const writeFile = (async (...args: Parameters<typeof real.writeFile>) => {
		const path = String(args[0]);
		await disk.first("writeFile", path);
		disk.refuse("writeFile", path);
		await real.writeFile(...args);
		await disk.pass("writeFile", path);
	}) as typeof real.writeFile;
	const mocked: Record<string, unknown> = {
		...real,
		...heard(real, ["stat", "lstat", "access", "unlink", "open", "readFile"]),
		rename,
		rm,
		link,
		writeFile,
	};
	return { ...mocked, default: mocked };
});

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const mocked: Record<string, unknown> = {
		...real,
		...heard(
			real,
			Object.keys(real).filter((name) => name.endsWith("Sync")),
		),
	};
	const write = mocked.writeFileSync as typeof real.writeFileSync;
	mocked.writeFileSync = ((...args: Parameters<typeof real.writeFileSync>) => {
		const [path] = args;
		if (disk.takesStaged && String(path).endsWith(".new"))
			real.writeFileSync(path, "taken\n");
		return write(...args);
	}) as typeof real.writeFileSync;
	return { ...mocked, default: mocked };
});

/**
 * `module`'s functions `names`, each writing down in `disk.asked` that
 * it was asked, and of which path, before it does as it would.
 */
function heard(
	module: object,
	names: readonly string[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const name of names) {
		const real: unknown = Reflect.get(module, name);
		if (typeof real !== "function") continue;
		out[name] = Object.assign((...args: unknown[]) => {
			disk.asked.push(`${name} ${String(args[0])}`);
			return Reflect.apply(real, module, args);
		}, real);
	}
	return out;
}

/**
 * What was asked of a path under `path` on the thread: the synchronous
 * calls, which hold it, and none of the reads off it.
 */
function askedOnThread(path: string): string[] {
	return disk.asked.filter(
		(said) => said.includes(path) && /^\w+Sync /.test(said),
	);
}

const PRIVATE = 0o600;
const PRIVATE_FOLDER = 0o700;
const READ_ONLY = 0o500;
const PERMISSIONS = 0o777;

/** A shell that is there: this process, which answers as one would. */
const HERE = process.pid;

/** A pid no process has: past every kernel's highest. */
const GONE = 999_999_999;

/**
 * How long a removal let go of is given to settle its call: well within
 * a test's own timeout, so a settle that never comes fails as itself.
 */
const SETTLES_IN_MS = 2_000;

/** When the calls started, and a moment soon after. */
const STARTED = 1_000;
const SOON = 2_000;

const made: string[] = [];
afterEach(() => {
	disk.go();
	disk.onRename = undefined;
	disk.refused = undefined;
	disk.refusal = "EIO";
	disk.takesStaged = false;
	vi.useRealTimers();
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

/**
 * Wait, on the real clock, for what was set aside to wait on the disk:
 * `vi.waitFor` moves a faked clock on as it asks, which would run a
 * call's wait out before the disk stands as the case needs.
 */
async function parkedByTheClock(): Promise<void> {
	const began = Date.now();
	while (disk.parked !== 1 && Date.now() - began < SETTLES_IN_MS)
		await new Promise((done) => setImmediate(done));
	expect(disk.parked, "what it set aside, waiting on the disk").toBe(1);
}

/** The labels of the calls recorded for `s1` in `where`, each one running. */
function labelsIn(where: string): string[] {
	return keptJobsOf("s1", where, () => true).map((one) => one.label);
}

/** What the kept folder holds, nothing staged left beside a record. */
function listed(where: string): string[] {
	return readdirSync(where);
}

/**
 * Run what the process runs as it exits, which a test can't have it do,
 * once it is there: one hook however many removals asked for it.
 */
function exiting(): void {
	const hooks = process
		.listeners("exit")
		.filter((hook) => hook.name === "takeRecordsBackAtExit");
	expect(hooks, "one hook as the process exits").toHaveLength(1);
	for (const hook of hooks) hook(0);
}

/**
 * What the process would say as it exits now, with the files it would
 * take back taken: nothing, once no removal runs.
 */
function saidAtExit(): string[] {
	const said = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		for (const hook of process.listeners("exit"))
			if (hook.name === "takeRecordsBackAtExit") hook(0);
		return said.mock.calls.map(([text]) => String(text));
	} finally {
		said.mockRestore();
	}
}

/**
 * How many removals an earlier case left running that an exit would act
 * on, read off the process's store without running the exit, which
 * would take their files back itself.
 */
function leftRunning(): number {
	const store: unknown = Reflect.get(
		globalThis,
		Symbol.for("agentic-harness.internal/shell/kept-jobs/records.v5"),
	);
	if (!isRecord(store)) return 0;
	const { removing, ending } = store;
	return (
		(removing instanceof Map ? removing.size : 0) +
		(ending instanceof Map ? ending.size : 0)
	);
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
		const found = await carriedCalls(where, SOON);
		expect([...found.groups], "its shell's group").toEqual([HERE]);
		expect([...found.marks], "its call's mark").toEqual(["mark-j1"]);
	});

	// A host reaps at every stop and sweep, on the loop its conversations
	// share, and a busy disk held that loop here for about 40 s a day.
	it("is read for every reaper off the thread, recorded or carried", async () => {
		const where = folder();
		await recorded(where, "s1", "j1", HERE);
		const carried = await makeKept(where);
		writeFileSync(`${carried}.pid`, "4242\n");
		markCarried(carried, "call-1");
		disk.forget();
		const found = await carriedCalls(where, SOON);
		expect(
			askedOnThread(where),
			"nothing asked of the folder on the thread",
		).toEqual([]);
		expect([...found.groups].sort(), "both shells' groups").toEqual(
			[HERE, 4242].sort(),
		);
		expect([...found.marks].sort(), "both calls' marks").toEqual([
			"call-1",
			"mark-j1",
		]);
	});

	it.each([
		["once its shell wrote how it ended", {}, HERE, true],
		["once its shell is gone", {}, GONE, false],
		["once its time limit passed", { deadline: SOON - 1 }, HERE, false],
	])("spares nothing %s", async (_case, extra, pid, ended) => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", pid, extra);
		if (ended) writeFileSync(`${job.work.keep}.end`, "0\n");
		const found = await carriedCalls(where, SOON);
		expect(found.groups.size + found.marks.size, "nothing left to spare").toBe(
			0,
		);
	});

	// A folder at the name fails for good, as no retry reads it: waiting
	// on it would end no reap again, so it says nothing and the rest read.
	// kept-faults.test.ts holds what a failure of the moment does.
	it.each([
		["a job's record", ".job"],
		["a carried call's mark", ".carried"],
	])(
		"reads %s that will never read as saying nothing, and reads the rest",
		async (_what, suffix) => {
			const where = folder();
			const job = await recorded(where, "s1", "j1", HERE);
			if (suffix === ".carried") markCarried(job.work.keep, "call-1");
			const other = await recorded(where, "s1", "j2", HERE);
			rmSync(`${job.work.keep}${suffix}`);
			mkdirSync(`${job.work.keep}${suffix}`);
			const found = await carriedCalls(where, SOON);
			expect(found.unread, "no reap waits on it").toBeUndefined();
			expect(found.marks.has(other.work.mark), "the rest still read").toBe(
				true,
			);
		},
	);

	it("says nothing went unread when every record read", async () => {
		const where = folder();
		await recorded(where, "s1", "j1", HERE);
		expect((await carriedCalls(where, SOON)).unread).toBeUndefined();
	});

	it("spares nothing a day after its call started", async () => {
		const where = folder();
		await recorded(where, "s1", "j1", HERE);
		const found = await carriedCalls(where, STARTED + RECORD_SPARED_FOR_MS);
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
		const found = await carriedCalls(where, SOON);
		expect(found.groups.size + found.marks.size, "nothing spared").toBe(0);
		expect(listed(where), "its pid still kept").toContain(
			`${job.work.keep.split("/").pop()}.pid`,
		);
	});

	it("never throws when what holds its name won't go", () => {
		const keep = join(folder(), "k1");
		mkdirSync(`${keep}.job`, { recursive: true });
		ownJobRecord(keep, "{}");
		expect(() => forgetKeptJob(keep)).not.toThrow();
	});

	// A session's recorder takes back at its close every call it ever
	// recorded, nearly all gone with their files long since.
	it("asks nothing of the disk at a session's close once its files went", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		await removeKept(job.work.keep);
		disk.forget();
		forgetKeptJob(job.work.keep);
		expect(
			disk.of(job.work.keep),
			"nothing asked, on the thread or off it",
		).toEqual({
			moved: [],
			removed: [],
			asked: [],
		});
	});

	it("is left at a session's close once its call was handed on", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disownKeptJob(job.work.keep);
		forgetKeptJob(job.work.keep);
		expect(
			existsSync(`${job.work.keep}.job`),
			"left for whoever took the call up",
		).toBe(true);
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
	// The exit reads every removal this worker runs, so each case opens
	// once those an earlier one left running have ended.
	beforeEach(async () => {
		await vi.waitFor(() =>
			expect(leftRunning(), "removals an earlier case left running").toBe(0),
		);
	});

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

	// The unlink of what was set aside can't be called back either.
	it("puts its record back when handed on while what it set aside went", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold(true, "rm");
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "what it set aside, waiting on the disk").toBe(1),
		);
		disownKeptJob(job.work.keep);
		disk.go();
		await going;
		expect(labelsIn(where), "its record, for the taker").toEqual(["run j1"]);
		expect(
			listed(where),
			"nothing left set aside or staged",
		).not.toContainEqual(expect.stringMatching(/\.(gone|back)$/));
	});

	it("leaves the taker's record when it was written while what it set aside went", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold(true, "rm");
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "what it set aside, waiting on the disk").toBe(1),
		);
		disownKeptJob(job.work.keep);
		recordKeptJob({ ...job, label: "taken up" });
		disk.go();
		await going;
		expect(labelsIn(where), "the taker's record").toEqual(["taken up"]);
		expect(listed(where), "nothing left staged").not.toContainEqual(
			expect.stringMatching(/\.back$/),
		);
	});

	// A rollover writes the record again as the removal begins, so what
	// the rename set aside is the newer.
	it("puts back the record it wrote last when handed on after setting aside a rewrite", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold(true, "rename");
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "its removal, waiting on the disk").toBe(1),
		);
		recordKeptJob({ ...job, label: "rolled over" });
		disk.go();
		disk.hold(true, "rm", /\.gone$/);
		await vi.waitFor(() =>
			expect(disk.waiting, "the rewrite, set aside").toEqual([
				expect.stringMatching(/^rm .*\.gone$/),
			]),
		);
		disownKeptJob(job.work.keep);
		disk.go();
		await going;
		expect(labelsIn(where), "the newest, for the taker").toEqual([
			"rolled over",
		]);
	});

	// A move hands its calls on and closes the session that gave them in
	// the same turn, so the giver's close always follows the hand-off.
	it("puts its record back for the taker though the giver's session closes after the hand-off", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "what it set aside, waiting on the disk").toBe(1),
		);
		disownKeptJob(job.work.keep);
		forgetKeptJob(job.work.keep);
		disk.go();
		await going;
		expect(labelsIn(where), "its record, for the taker").toEqual(["run j1"]);
		expect(
			listed(where),
			"nothing left set aside or staged",
		).not.toContainEqual(expect.stringMatching(/\.(gone|back)$/));
	});

	it("links back what it set aside, though the giver's session closes, when handed on before the rename answered", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold();
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(existsSync(`${job.work.keep}.job`), "set aside").toBe(false),
		);
		disownKeptJob(job.work.keep);
		forgetKeptJob(job.work.keep);
		disk.go();
		await going;
		expect(labelsIn(where), "its record, for the taker").toEqual(["run j1"]);
		expect(listed(where), "nothing left set aside").not.toContainEqual(
			expect.stringMatching(/\.gone$/),
		);
	});

	// The close runs on the thread while the removal's rename still waits
	// for the disk; removing the record then would leave the taker none.
	it("leaves the record for the taker when the giver's session closes before its removal's rename starts", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold(true);
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "its rename, waiting on the disk").toBe(1),
		);
		expect(existsSync(`${job.work.keep}.job`), "still at its name").toBe(true);
		disownKeptJob(job.work.keep);
		forgetKeptJob(job.work.keep);
		disk.go();
		await going;
		expect(labelsIn(where), "its record, for the taker").toEqual(["run j1"]);
	});

	// A removal still running waits on a slow disk, and in a host the
	// process lives on past a session's close: an unlink on the thread
	// there would hold every conversation for as long as the disk takes.
	it("leaves a record its call's own removal still holds to that removal at a session's close", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold(true);
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "its rename, waiting on the disk").toBe(1),
		);
		disk.forget();
		forgetKeptJob(job.work.keep);
		expect(
			disk.of(job.work.keep).asked,
			"nothing asked of the disk on the thread",
		).toEqual([]);
		expect(
			existsSync(`${job.work.keep}.job`),
			"its record, left to its removal",
		).toBe(true);
		disk.go();
		await going;
		expect(
			listed(where).filter((name) => name.includes(".job")),
			"no record, nor its aside",
		).toEqual([]);
	});

	// A pi exiting mid-removal leaves the pool's work undone, so a record
	// left at its name would stand beside the call's end for its next start
	// to say again.
	it("is taken back on the thread as the process exits while its call's own removal waits on the disk", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold(true);
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "its rename, waiting on the disk").toBe(1),
		);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		exiting();
		const lines = said.mock.calls.map(([text]) => String(text));
		said.mockRestore();
		expect(
			existsSync(`${job.work.keep}.job`),
			"its record, taken back before the disk got to the removal",
		).toBe(false);
		expect(
			lines,
			"how many it takes back, said before it waits on the disk",
		).toEqual([
			expect.stringMatching(
				/^\[shell\] taking back up to 1 kept file the disk .* exits\n$/,
			),
		]);
		disk.go();
		await going;
		expect(
			listed(where).filter((name) => name.includes(".job")),
			"no record, nor its aside",
		).toEqual([]);
	});

	// A call whose wait ran out has its files go at once, the removal still
	// waiting on the disk: the likeliest way a pi exits mid-removal.
	// keeping.ts removes it as a call never handed on, so its exit takes
	// back the record alone, through the record's own removal.
	it("is taken back as the process exits once its call's files began to go mid-removal", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold(true);
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "its rename, waiting on the disk").toBe(1),
		);
		// Written again as the files begin to go, as a rollover's recorder
		// can: the exit still asks after its one name once.
		recordKeptJob(job);
		const removing = removeKept(job.work.keep, { neverHanded: true });
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		exiting();
		const lines = said.mock.calls.map(([text]) => String(text));
		said.mockRestore();
		expect(lines, "its record alone, counted once").toEqual([
			expect.stringMatching(
				/^\[shell\] taking back up to 1 kept file the disk .* exits\n$/,
			),
		]);
		expect(
			existsSync(`${job.work.keep}.job`),
			"its record, taken back before the disk got to it",
		).toBe(false);
		disk.go();
		await Promise.all([going, removing]);
	});

	// Two removals of one call can run at once, as a close and a stop can
	// each start one: the first past its marks leaves them to the other.
	// Each removal adds the marks it may find, so whichever comes first,
	// the exit takes back every mark either may have yet to reach.
	it.each([
		["one that may find any", "one never handed", {}, { neverHanded: true }],
		["one never handed", "one that may find any", { neverHanded: true }, {}],
	])(
		"takes back a call's marks as the process exits while another of its removals runs: %s, then %s",
		async (_first, _second, firstSays, secondSays) => {
			const where = folder();
			const job = await recorded(where, "s1", "j1", HERE);
			const keep = job.work.keep;
			disk.hold(true, "rm", /\.carried$/);
			const first = removeKept(keep, firstSays);
			await vi.waitFor(() =>
				expect(disk.parked, "the first removal, waiting on the disk").toBe(1),
			);
			disk.on = /never/;
			await removeKept(keep, secondSays);
			writeFileSync(`${keep}.carried`, "carried\n");
			exiting();
			expect(
				existsSync(`${keep}.carried`),
				"its carried mark, which the running removal has yet to reach",
			).toBe(false);
			disk.go();
			await first;
		},
	);

	it("takes back no marks as the process exits for a removal already past them", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const keep = job.work.keep;
		disk.hold(true, "rm", /\.out$/);
		const removing = removeKept(keep);
		await vi.waitFor(() =>
			expect(disk.waiting, "the removal, on its output").toEqual([
				`rm ${keep}.out`,
			]),
		);
		writeFileSync(`${keep}.carried`, "carried\n");
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		exiting();
		const lines = said.mock.calls.map(([text]) => String(text));
		said.mockRestore();
		expect(
			existsSync(`${keep}.carried`),
			"a mark written since, no removal's",
		).toBe(true);
		expect(lines, "nothing to take back, so nothing said").toEqual([]);
		disk.go();
		await removing;
	});

	// Most calls end here, never handed on, and never wrote a record: an
	// exit on the slow disk that left their files going asks after none.
	it("asks after no mark as the process exits for a call that ran here and recorded none", async () => {
		const keep = await makeKept(folder());
		disk.hold(true, "rm", /\.job$/);
		const removing = removeKept(keep, { neverHanded: true });
		await vi.waitFor(() =>
			expect(disk.waiting, "the removal, on its record's name").toEqual([
				`rm ${keep}.job`,
			]),
		);
		expect(saidAtExit(), "no name to ask after, so nothing said").toEqual([]);
		disk.go();
		await removing;
	});

	it("asks after only its record as the process exits for a call that ran here and recorded one", async () => {
		const job = await recorded(folder(), "s1", "j1", HERE);
		const keep = job.work.keep;
		disk.hold(true, "rm", /\.job$/);
		const removing = removeKept(keep, { neverHanded: true });
		await vi.waitFor(() =>
			expect(disk.waiting, "the removal, on its record").toEqual([
				`rm ${keep}.job`,
			]),
		);
		expect(saidAtExit(), "its record alone").toEqual([
			expect.stringMatching(/taking back up to 1 kept file the disk/),
		]);
		expect(existsSync(`${keep}.job`), "its record, taken back").toBe(false);
		disk.go();
		await removing;
	});

	it("takes nothing back as the process exits for a removal that stopped at a mark", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const keep = job.work.keep;
		disk.refused = "rm";
		await removeKept(keep);
		disk.refused = undefined;
		writeFileSync(`${keep}.carried`, "carried\n");
		exiting();
		expect(
			existsSync(`${keep}.carried`),
			"a mark written since, no removal's",
		).toBe(true);
	});

	// What carries a call over a pi's exit: its next start takes it up.
	it("leaves a running call's record as the process exits while another call's removal waits", async () => {
		const where = folder();
		const running = await recorded(where, "s1", "j1", HERE);
		const ending = await recorded(where, "s1", "j2", HERE);
		disk.hold(true);
		const going = forgetOwnKeptJob(ending.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "the other's rename, waiting on the disk").toBe(1),
		);
		exiting();
		expect(
			existsSync(`${running.work.keep}.job`),
			"the running call's record, for its next start",
		).toBe(true);
		disk.go();
		await going;
		expect(labelsIn(where), "the running call alone").toEqual(["run j1"]);
	});

	// A rollover's recorder can write the record again while the removal
	// waits on a slow disk; the removal takes each record it finds in turn,
	// so a close unlinking it on the thread would only wait on that disk.
	it("leaves a record written again mid-removal to that removal at a session's close", async () => {
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
		disk.forget();
		forgetKeptJob(job.work.keep);
		expect(
			disk.of(job.work.keep).asked,
			"nothing asked of the disk on the thread",
		).toEqual([]);
		disk.go();
		await going;
		expect(
			listed(where).filter((name) => name.includes(".job")),
			"no record, nor its aside",
		).toEqual([]);
	});

	// The pool's own put-back goes with the process, so the exit links
	// back what was set aside for the taker itself.
	it("puts back what it set aside for its taker as the process exits, when handed on mid-removal", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold();
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(existsSync(`${job.work.keep}.job`), "set aside").toBe(false),
		);
		disownKeptJob(job.work.keep);
		const said = saidAtExit();
		expect(labelsIn(where), "its record, for the taker").toEqual(["run j1"]);
		expect(listed(where), "nothing left set aside").not.toContainEqual(
			expect.stringMatching(/\.gone$/),
		);
		expect(said, "a record stands, so nothing said").toEqual([]);
		// The process would be gone here; its pool's put-back, let go only so
		// the case ends, finds nothing left to link back and says so.
		const late = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			disk.go();
			await going;
		} finally {
			late.mockRestore();
		}
		expect(labelsIn(where), "its record, still").toEqual(["run j1"]);
	});

	// Handed on as what it set aside goes: its put-back is yet to be
	// written as the process exits, so the call has no record for a while.
	it("says a call handed on as the process exits has no record put back, when what it set aside went", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.hold(false, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(
				disk.of(job.work.keep).removed.some((path) => path.endsWith(".gone")) &&
					!listed(where).some((name) => name.endsWith(".gone")),
				"what it set aside, gone, its callback yet to come",
			).toBe(true),
		);
		disownKeptJob(job.work.keep);
		expect(saidAtExit(), "the call left without a record").toEqual([
			"[shell] 1 call handed on as pi exits has no record put back, until its taker writes one\n",
		]);
		disk.go();
		await going;
		expect(labelsIn(where), "its record, put back as pi lives on").toEqual([
			"run j1",
		]);
	});

	// Handed on in the turn after a pass removed it, before the removal
	// looks again: as a hand-off during the pass would be, it is put back.
	it("puts its record back when handed on just after a pass removed it", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const keep = job.work.keep;
		let handed = false;
		// The pass's timing reads the clock once the pass has ended: handed
		// on there, at the first read finding its record removed, however
		// many reads come before.
		const now = (): number => {
			const removed =
				disk.of(keep).removed.some((path) => path.endsWith(".gone")) &&
				!existsSync(`${keep}.job`) &&
				!listed(where).some((name) => name.endsWith(".gone"));
			if (removed && !handed) {
				handed = true;
				disownKeptJob(keep);
			}
			return 0;
		};
		await forgetOwnKeptJob(keep, { now });
		expect(handed, "handed on once the pass had removed it").toBe(true);
		await vi.waitFor(() =>
			expect(labelsIn(where), "its record, for the taker").toEqual(["run j1"]),
		);
		expect(
			listed(where),
			"nothing left set aside or staged",
		).not.toContainEqual(expect.stringMatching(/\.(gone|back)$/));
	});

	// A disk refusing the rename leaves the record at its name, still this
	// process's: its files' removal takes it, and an exit before that does.
	it("holds a record the disk wouldn't set aside as this process's, for an exit to take back", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		disk.refused = "rename";
		const stays = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			await forgetOwnKeptJob(job.work.keep);
		} finally {
			stays.mockRestore();
			disk.refused = undefined;
		}
		expect(existsSync(`${job.work.keep}.job`), "still at its name").toBe(true);
		disk.hold(true, "rm", /\.job$/);
		const removing = removeKept(job.work.keep, { neverHanded: true });
		await vi.waitFor(() =>
			expect(disk.waiting, "the removal, on its record").toEqual([
				`rm ${job.work.keep}.job`,
			]),
		);
		expect(saidAtExit(), "its record, asked after").toEqual([
			expect.stringMatching(/taking back up to 1 kept file the disk/),
		]);
		expect(existsSync(`${job.work.keep}.job`), "taken back").toBe(false);
		disk.go();
		await removing;
	});

	// Handed on, or its files gone, while the disk had yet to answer: the
	// record at its name is the taker's, or beside the call's end, and no
	// longer this process's to take back at a session's close.
	it("leaves a record the disk wouldn't set aside to its taker when handed on meanwhile", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const keep = job.work.keep;
		disk.hold(true, "rename", /\.job$/);
		const going = forgetOwnKeptJob(keep);
		await parkedByTheClock();
		disownKeptJob(keep);
		disk.refused = "rename";
		const stays = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			disk.go();
			await going;
		} finally {
			stays.mockRestore();
			disk.refused = undefined;
		}
		forgetKeptJob(keep);
		expect(labelsIn(where), "its record, the taker's").toEqual(["run j1"]);
	});

	it("asks nothing at a session's close of a record the disk wouldn't set aside once its files went meanwhile", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const keep = job.work.keep;
		disk.hold(true, "rename", /\.job$/);
		const going = forgetOwnKeptJob(keep);
		await parkedByTheClock();
		await removeKept(keep, { neverHanded: true });
		disk.refused = "rename";
		const stays = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			disk.go();
			await going;
		} finally {
			stays.mockRestore();
			disk.refused = undefined;
		}
		disk.forget();
		forgetKeptJob(keep);
		expect(disk.of(keep).asked, "nothing asked on the thread").toEqual([]);
	});

	// A rename asked before the exit is the pool's to finish after it, its
	// answer never heard: the exit leaves the record where that rename,
	// landing, moves nothing.
	it("leaves a call handed on mid-removal to its taker as the process exits, though its rename lands after", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const keep = job.work.keep;
		disk.hold(true, "rename", /\.job$/);
		const going = forgetOwnKeptJob(keep);
		await parkedByTheClock();
		disownKeptJob(keep);
		expect(saidAtExit(), "a record stands, so nothing said").toEqual([]);
		disk.go();
		disk.hold(false, "rename", /\.job$/);
		await vi.waitFor(() =>
			expect(disk.acted, "its rename, landed").toContain(`rename ${keep}.job`),
		);
		expect(labelsIn(where), "its record, for the taker").toEqual(["run j1"]);
		disk.go();
		await going;
		expect(labelsIn(where), "its record, still").toEqual(["run j1"]);
	});

	// A reload in one process: the taker writes its own before the exit.
	it("leaves the taker's own record as the process exits, when handed on mid-removal", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const keep = job.work.keep;
		disk.hold();
		const going = forgetOwnKeptJob(keep);
		await vi.waitFor(() =>
			expect(existsSync(`${keep}.job`), "set aside").toBe(false),
		);
		disownKeptJob(keep);
		recordKeptJob({ ...job, label: "taken up" });
		expect(saidAtExit(), "a record stands, so nothing said").toEqual([]);
		expect(labelsIn(where), "the taker's record").toEqual(["taken up"]);
		expect(listed(where), "nothing left set aside").not.toContainEqual(
			expect.stringMatching(/\.gone$/),
		);
		const late = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			disk.go();
			await going;
		} finally {
			late.mockRestore();
		}
		expect(labelsIn(where), "the taker's record, still").toEqual(["taken up"]);
	});

	// A rollover's write lands while the rename waits, so the rename moves
	// it and the next pass finds nothing at its name: the record this
	// process wrote last is gone, and a hand-off then has it put back.
	it("puts back the record it wrote last when handed on as a later pass finds it removed already", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const keep = job.work.keep;
		disk.hold(true, "rename", /\.job$/);
		const going = forgetOwnKeptJob(keep);
		await parkedByTheClock();
		recordKeptJob({ ...job, label: "rolled over" });
		let renames = 0;
		disk.onRename = (path) => {
			if (path !== `${keep}.job`) return;
			renames += 1;
			if (renames === 1) disownKeptJob(keep);
		};
		disk.go();
		await going;
		expect(renames, "a second pass, handed on as it renamed").toBe(1);
		await vi.waitFor(() =>
			expect(labelsIn(where), "the record it wrote last").toEqual([
				"rolled over",
			]),
		);
		expect(listed(where), "nothing set aside or staged").not.toContainEqual(
			expect.stringMatching(/\.(gone|back)$/),
		);
	});

	// The put-back's link, asked before the exit, lands after it: what it
	// links from is gone by then, so no record stands beside the call's end.
	it("takes back as the process exits a put-back still on its way once its taker removed the call's files", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const keep = job.work.keep;
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(keep);
		await parkedByTheClock();
		disownKeptJob(keep);
		disk.go();
		disk.hold(true, "link");
		await vi.waitFor(() =>
			expect(disk.waiting, "its put-back, waiting on the disk").toEqual([
				expect.stringMatching(/^link .*\.job$/),
			]),
		);
		await removeKept(keep);
		exiting();
		const late = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			disk.go();
			disk.hold(false, "link");
			await vi.waitFor(() =>
				expect(disk.acted, "its put-back, landed").toContain(
					`link ${keep}.job`,
				),
			);
			expect(
				existsSync(`${keep}.job`),
				"no record beside the call's files at its next start",
			).toBe(false);
			disk.go();
			await going;
		} finally {
			late.mockRestore();
		}
	});

	// A rollover's recorder can write the record again once the call's own
	// removal has ended, where only the session's close takes it back.
	it("leaves no record once a close took back one written after its removal ended", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		await forgetOwnKeptJob(job.work.keep);
		recordKeptJob({ ...job, label: "rolled over" });
		expect(labelsIn(where), "written again").toEqual(["rolled over"]);
		forgetKeptJob(job.work.keep);
		expect(
			listed(where).filter((name) => name.includes(".job")),
			"no record, nor its aside",
		).toEqual([]);
	});

	// A taker in this process that ended the call removed its files, end
	// and all; a record put back beside them has a start say it again.
	it("puts nothing back once its taker has ended the call and removed its files", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		writeFileSync(`${job.work.keep}.end`, "0\n");
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "what it set aside, waiting on the disk").toBe(1),
		);
		disownKeptJob(job.work.keep);
		await removeKept(job.work.keep);
		disk.go();
		await going;
		expect(
			listed(where).filter((name) => name.includes(".job")),
			"no record beside the call's files, nor one staged",
		).toEqual([]);
	});

	it("takes back what it put back when its taker removed the call's files as it landed", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		writeFileSync(`${job.work.keep}.end`, "0\n");
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "what it set aside, waiting on the disk").toBe(1),
		);
		disownKeptJob(job.work.keep);
		disk.go();
		disk.hold(true, "link");
		// The put-back itself, not the removal let go a moment before.
		await vi.waitFor(() =>
			expect(disk.waiting, "its put-back, waiting on the disk").toEqual([
				expect.stringMatching(/^link .*\.job$/),
			]),
		);
		await removeKept(job.work.keep);
		disk.go();
		await going;
		expect(
			listed(where).filter((name) => name.includes(".job")),
			"no record beside the call's files, nor one staged",
		).toEqual([]);
	});

	// The put-back lands after the taker's removal ended, and the process
	// exits before the put-back takes its record back off the disk.
	it("takes back as the process exits what it put back once its taker removed the call's files", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const keep = job.work.keep;
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(keep);
		await vi.waitFor(() =>
			expect(disk.parked, "what it set aside, waiting on the disk").toBe(1),
		);
		disownKeptJob(keep);
		disk.go();
		disk.hold(true, "link");
		await vi.waitFor(() =>
			expect(disk.waiting, "its put-back, waiting on the disk").toEqual([
				expect.stringMatching(/^link .*\.job$/),
			]),
		);
		await removeKept(keep);
		disk.go();
		disk.hold(false, "link");
		await vi.waitFor(() =>
			expect(existsSync(`${keep}.job`), "its put-back, landed").toBe(true),
		);
		exiting();
		expect(
			existsSync(`${keep}.job`),
			"no record beside the call's files at its next start",
		).toBe(false);
		disk.go();
		await going;
	});

	// Whatever can write the kept folder (not a fenced command, whose fence
	// keeps it read-only) can put one there, since the staged name carries
	// the host's pid, which every record names; as can a write that died.
	// The disk refusing to write what goes back is in its own case.
	it("writes its record back through nothing planted at its staged name", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const target = join(where, "..", "read-only");
		writeFileSync(target, "untouched\n");
		symlinkSync(target, `${job.work.keep}.job.${process.pid}.back`);
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "what it set aside, waiting on the disk").toBe(1),
		);
		disownKeptJob(job.work.keep);
		disk.go();
		await going;
		expect(readFileSync(target, "utf8"), "what the planted link names").toBe(
			"untouched\n",
		);
		expect(labelsIn(where), "its record, for the taker").toEqual(["run j1"]);
		expect(listed(where), "nothing left staged").not.toContainEqual(
			expect.stringMatching(/\.back$/),
		);
	});

	it("says it couldn't put its record back when the disk refuses to link what it wrote, leaving nothing staged", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(disk.parked, "what it set aside, waiting on the disk").toBe(1),
		);
		disk.refused = "link";
		disownKeptJob(job.work.keep);
		disk.go();
		await expect(going).resolves.toBeUndefined();
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"one line naming it and what follows",
		).toEqual([
			// Its aside went before it wrote, so none is said to stay.
			expect.stringMatching(
				/^(?!.*stays set aside).*couldn't put .*\.job back .*: EIO.*to strays/,
			),
		]);
		expect(listed(where), "nothing left staged, nor aside").not.toContainEqual(
			expect.stringMatching(/\.(back|gone)$/),
		);
	});

	it.each([
		["a failing disk", "EIO", "EIO"],
		["its staged name, taken again as it was written", "EEXIST", "taken again"],
	])(
		"says it couldn't write its record back when refused by %s, leaving nothing staged",
		async (_, refusal, why) => {
			const where = folder();
			const job = await recorded(where, "s1", "j1", HERE);
			const said = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			disk.hold(true, "rm", /\.gone$/);
			const going = forgetOwnKeptJob(job.work.keep);
			await vi.waitFor(() =>
				expect(disk.parked, "what it set aside, waiting on the disk").toBe(1),
			);
			disk.refused = "writeFile";
			disk.refusal = refusal;
			disownKeptJob(job.work.keep);
			disk.go();
			await expect(going).resolves.toBeUndefined();
			expect(
				said.mock.calls
					.map(([text]) => String(text))
					.filter((text) => text.includes(job.work.keep)),
				"one line naming it and what follows",
			).toEqual([
				expect.stringMatching(
					new RegExp(
						`^(?!.*stays set aside).*couldn't put .*\\.job back .*${why}.*to strays`,
					),
				),
			]);
			expect(
				listed(where),
				"nothing left staged, nor aside",
			).not.toContainEqual(expect.stringMatching(/\.(back|gone)$/));
		},
	);

	// What it set aside may be the taker's own write, kept rather than lost.
	it("says it couldn't put its record back when the disk refuses it, keeping what it set aside", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		disk.hold();
		const going = forgetOwnKeptJob(job.work.keep);
		await vi.waitFor(() =>
			expect(existsSync(`${job.work.keep}.job`), "set aside").toBe(false),
		);
		disk.refused = "link";
		disownKeptJob(job.work.keep);
		disk.go();
		await expect(going).resolves.toBeUndefined();
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"one line naming it and what follows",
		).toEqual([
			expect.stringMatching(
				/couldn't put .*\.job back .*: EIO.*stays set aside at .*\.gone.*to strays/,
			),
		]);
		expect(listed(where), "what it set aside, kept").toContainEqual(
			expect.stringMatching(/\.gone$/),
		);
	});

	it("says what it set aside stays when the disk refuses its removal, and what follows", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		disk.refused = "rm";
		await expect(forgetOwnKeptJob(job.work.keep)).resolves.toBeUndefined();
		expect(existsSync(`${job.work.keep}.job`), "no record to read").toBe(false);
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"one line naming it and what follows",
		).toEqual([
			expect.stringMatching(
				/couldn't remove .*\.gone: EIO.*no start reads it as a record/,
			),
		]);
	});

	// Each wait-line case runs its wait out only once the disk stands as
	// the case says, so a slow disk can't pick the line for it.
	it("says its record is set aside already when only that removal outlasts its wait", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep, { waitMs: 50 });
		await parkedByTheClock();
		vi.advanceTimersByTime(50);
		await going;
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"one line, that no start reads it",
		).toEqual([
			expect.stringMatching(/set aside already, where no start reads it/),
		]);
		disk.go();
		await vi.waitFor(() =>
			expect(
				listed(where),
				"what it set aside, gone once the disk lets it",
			).not.toContainEqual(expect.stringMatching(/\.gone$/)),
		);
	});

	it("says its call was handed on when that came before its removal outlasted its wait", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep, { waitMs: 200 });
		await parkedByTheClock();
		disownKeptJob(job.work.keep);
		vi.advanceTimersByTime(200);
		await going;
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"one line, that the call is its taker's",
		).toEqual([expect.stringMatching(/handed on meanwhile.*to strays/)]);
		disk.go();
		await vi.waitFor(() =>
			expect(labelsIn(where), "its record, back for the taker").toEqual([
				"run j1",
			]),
		);
	});

	// A move that couldn't be written stops what it handed and removes
	// its files, so no taker comes for the call.
	it("says its call's files went when a hand-off was undone before its removal outlasted its wait", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep, { waitMs: 200 });
		await parkedByTheClock();
		disownKeptJob(job.work.keep);
		await removeKept(job.work.keep);
		vi.advanceTimersByTime(200);
		await going;
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"one line, that nothing takes the call up",
		).toEqual([expect.stringMatching(/files went meanwhile/)]);
		disk.go();
		await vi.waitFor(() =>
			expect(
				listed(where).filter((name) => name.includes(".job")),
				"no record put back",
			).toEqual([]),
		);
	});

	it("stops waiting, saying nothing, once the call is stopped", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const stop = new AbortController();
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep, {
			signal: stop.signal,
			waitMs: 60_000,
		});
		await parkedByTheClock();
		stop.abort();
		expect(
			await Promise.race([
				going.then(() => "ended"),
				new Promise((done) => setTimeout(() => done("held"), SETTLES_IN_MS)),
			]),
			"its wait, ended by the stop",
		).toBe("ended");
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"nothing said of a removal a stopped call leaves to its files'",
		).toEqual([]);
		disk.go();
		await vi.waitFor(() =>
			expect(
				listed(where).filter((name) => name.includes(".job")),
				"its removal, gone on behind",
			).toEqual([]),
		);
	});

	// A stopped call's files go just after its wait ends, record first,
	// while the removal's rename may still wait for the disk's pool.
	it("leaves nothing once a stopped call's files go before its removal's rename starts", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const stop = new AbortController();
		disk.hold(true, "rename");
		const going = forgetOwnKeptJob(job.work.keep, { signal: stop.signal });
		await parkedByTheClock();
		stop.abort();
		await going;
		await removeKept(job.work.keep);
		disk.go();
		await vi.waitFor(() =>
			expect(
				listed(where).filter((name) => name.includes(".job")),
				"no record, nor its aside",
			).toEqual([]),
		);
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"nothing said of a record that went with its files",
		).toEqual([]);
	});

	it("waits for nothing when its call was stopped before it began", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const stop = new AbortController();
		stop.abort();
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep, {
			signal: stop.signal,
			waitMs: 60_000,
		});
		expect(
			await Promise.race([
				going.then(() => "ended"),
				new Promise((done) => setTimeout(() => done("held"), SETTLES_IN_MS)),
			]),
			"its wait, ended by the stop that came first",
		).toBe("ended");
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"nothing said",
		).toEqual([]);
		disk.go();
	});

	// A call's signal can be its whole run's, which outlives the call, so a
	// listener left on it would hold each call's wait until the run ends.
	it.each([
		["its removal ends", false],
		["its wait runs out", true],
	])(
		"takes its stop's listener off the call's signal once %s",
		async (_, held) => {
			const where = folder();
			const job = await recorded(where, "s1", "j1", HERE);
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const run = new AbortController();
			if (held) disk.hold(true, "rm", /\.gone$/);
			await forgetOwnKeptJob(job.work.keep, {
				signal: run.signal,
				waitMs: held ? 50 : 60_000,
			});
			expect(
				getEventListeners(run.signal, "abort"),
				"listeners left on the run's signal",
			).toEqual([]);
			disk.go();
		},
	);

	it("says a record written again stands at its name when its removal outlasts its wait", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		disk.hold(true, "rm", /\.gone$/);
		const going = forgetOwnKeptJob(job.work.keep, { waitMs: 200 });
		await parkedByTheClock();
		recordKeptJob(job);
		vi.advanceTimersByTime(200);
		await going;
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"one line, that a start may take it up",
		).toEqual([expect.stringMatching(/may say the call's end again/)]);
		disk.go();
		await vi.waitFor(() =>
			expect(
				listed(where).filter((name) => name.includes(".job")),
				"the record written again, taken in turn",
			).toEqual([]),
		);
	});

	it("leaves a second take-back to the removal already running", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		disk.hold(true);
		await forgetOwnKeptJob(job.work.keep, { waitMs: 50 });
		recordKeptJob(job);
		disk.forget();
		await forgetOwnKeptJob(job.work.keep, { waitMs: 50 });
		expect(disk.of(job.work.keep).moved, "no second removal begun").toEqual([]);
		disk.go();
		await vi.waitFor(() =>
			expect(
				listed(where).filter((name) => name.includes(".job")),
				"the record written again, taken by the first",
			).toEqual([]),
		);
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

	// The bound a bash call's end is held to, which keeping.ts leaves to
	// the default: a wedged disk holds the call 5 s, no more and no less.
	it("lets its call settle 5 s into a wedged disk when told no wait of its own", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		disk.hold(true);
		let settled = false;
		const going = forgetOwnKeptJob(job.work.keep).then(() => {
			settled = true;
		});
		await parkedByTheClock();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(settled, "still waiting just short of 5 s").toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await going;
		expect(settled, "settled at 5 s").toBe(true);
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

	// An NTP step or a resumed VM moves the wall clock mid-removal.
	it("says nothing of a fast removal across a step of the wall clock", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const wall = [0, 3_600_000];
		const stepped = vi
			.spyOn(Date, "now")
			.mockImplementation(() => wall.shift() ?? 3_600_000);
		try {
			await forgetOwnKeptJob(job.work.keep);
		} finally {
			stepped.mockRestore();
		}
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"no line: the removal took no time",
		).toEqual([]);
	});

	// A slow refusal is the busy disk's own signature.
	it("says a removal that took more than a second though the disk refused it", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		disk.refused = "rename";
		const clock = [0, 1_500];
		await forgetOwnKeptJob(job.work.keep, { now: () => clock.shift() ?? 0 });
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"that it stays, and how long it took",
		).toEqual([
			expect.stringMatching(/couldn't remove .*\.job: EIO.*it stays/),
			expect.stringMatching(/took 1500 ms/),
		]);
	});

	it("is written through nothing planted at its staged name", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const target = join(where, "..", "read-only");
		writeFileSync(target, "untouched\n");
		symlinkSync(target, `${job.work.keep}.job.${process.pid}.new`);
		recordKeptJob({ ...job, label: "again" });
		expect(readFileSync(target, "utf8"), "what the planted link names").toBe(
			"untouched\n",
		);
		expect(labelsIn(where), "its record, written whole").toEqual(["again"]);
		expect(listed(where), "nothing left staged").not.toContainEqual(
			expect.stringMatching(/\.new$/),
		);
	});

	it("says its record couldn't be written when its staged name is taken again as it is written", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		disk.takesStaged = true;
		recordKeptJob({ ...job, label: "again" });
		disk.takesStaged = false;
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"one line saying the record wasn't written",
		).toEqual([
			expect.stringMatching(
				/couldn't record .*\.job: .*taken again.*; a pi gone before the call ends leaves it unsaid/,
			),
		]);
		expect(labelsIn(where), "the record it had, still at its name").toEqual([
			"run j1",
		]);
		expect(listed(where), "nothing left staged").not.toContainEqual(
			expect.stringMatching(/\.new$/),
		);
	});

	// Root's writes pass a folder's mode, so there is nothing to refuse them.
	it.skipIf(process.getuid?.() === 0)(
		"says its record couldn't be written when the disk refuses it",
		async () => {
			const where = folder();
			const job = await recorded(where, "s1", "j1", HERE);
			const said = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			chmodSync(where, READ_ONLY);
			try {
				recordKeptJob({ ...job, label: "again" });
			} finally {
				// Writable again before the folder is cleared away.
				chmodSync(where, PRIVATE_FOLDER);
			}
			expect(
				said.mock.calls
					.map(([text]) => String(text))
					.filter((text) => text.includes(job.work.keep)),
				"one line saying the record wasn't written",
			).toEqual([expect.stringMatching(/couldn't record .*\.job: .*EACCES/)]);
		},
	);

	// A folder there is no write's of this code, so nothing would take it
	// away; its record is said unwritten, and nothing leaves the write.
	it("says its record couldn't be written, throwing nothing, when a folder holds its staged name", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		mkdirSync(`${job.work.keep}.job.${process.pid}.new`);
		expect(
			() => recordKeptJob({ ...job, label: "again" }),
			"nothing thrown into its recorder",
		).not.toThrow();
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"one line saying the record wasn't written",
		).toEqual([
			expect.stringMatching(
				/couldn't record .*\.job: .*; a pi gone before the call ends leaves it unsaid/,
			),
		]);
		expect(labelsIn(where), "the record it had, still at its name").toEqual([
			"run j1",
		]);
	});

	it("says nothing when the kept folder is gone before its record was written", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const said = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		rmSync(where, { recursive: true, force: true });
		recordKeptJob({ ...job, label: "again" });
		expect(
			said.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.includes(job.work.keep)),
			"nothing to say of a call already gone",
		).toEqual([]);
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
			).toEqual([
				expect.stringMatching(
					/couldn't remove .*\.job: .*it stays, so this pi's next start may say the call's end again/,
				),
			]);
		},
	);

	// pi loads each extension as a module copy of its own, and job-workflow
	// records the job while shell-workflow ends the call, so the two always
	// sit in different copies; a reload makes another copy again.
	it("is taken back by a copy of this code loaded after it was written", async () => {
		const where = folder();
		const job = await recorded(where, "s1", "j1", HERE);
		const store = Symbol.for(
			"agentic-harness.internal/shell/kept-jobs/records.v5",
		);
		const records = (): { takeBack: () => void } | undefined =>
			(globalThis as Record<symbol, { takeBack: () => void } | undefined>)[
				store
			];
		const takeBack = (): unknown => records()?.takeBack;
		// The exit's hook, armed by a copy loaded before.
		await removeKept(join(where, "another"));
		const before = takeBack();
		vi.resetModules();
		const again = await import("../../../../lib/internal/shell/kept-jobs.ts");
		expect(takeBack(), "the exit's take-back, the newer copy's").not.toBe(
			before,
		);
		const newest = records();
		if (!newest) throw new Error("the job records, gone from the process");
		const loaded = newest.takeBack;
		const ran = vi.fn();
		newest.takeBack = ran;
		try {
			exiting();
		} finally {
			newest.takeBack = loaded;
		}
		expect(
			ran,
			"the exit, through whichever copy loaded last",
		).toHaveBeenCalledOnce();
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
		disk.forget();
		expect(
			(await strayKeptJobs(where, (pid) => pid === 77)).map((job) => job.id),
		).toEqual(["stray"]);
		expect(
			askedOnThread(where),
			"read off the thread, as a host's sweep reads it",
		).toEqual([]);
	});

	it("is none before there is a folder", async () => {
		expect(await strayKeptJobs(folder())).toEqual([]);
	});

	// A folder at its end's name stands in for EIO: one record that won't
	// read must not keep the watch from every other stray.
	it("is one whose end won't read, beside the rest", async () => {
		const where = folder();
		const unread = await recorded(where, "s1", "unread", 4242, { owner: 88 });
		await recorded(where, "s1", "stray", 4242, { owner: 88 });
		mkdirSync(`${unread.work.keep}.end`);
		expect(
			(await strayKeptJobs(where, () => false)).map((job) => job.id).sort(),
			"an end not read is an end not said",
		).toEqual(["stray", "unread"]);
	});
});
