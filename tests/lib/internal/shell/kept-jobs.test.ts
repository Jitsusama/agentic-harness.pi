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
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const rename = (async (...args: Parameters<typeof real.rename>) => {
		const path = String(args[0]);
		disk.moved.push(path);
		await disk.first("rename", path);
		disk.refuse("rename", path);
		await real.rename(...args);
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
		disk.refuse("link", path);
		await real.link(...args);
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

	// A session closed for good takes its record back, which nothing may
	// bring back after.
	it("puts nothing back once a close for good took its record back", async () => {
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
		expect(
			listed(where).filter((name) => name.includes(".job")),
			"no record, nor one staged",
		).toEqual([]);
	});

	// Handed on before the rename answered, it would link the aside back,
	// unless a close for good came after.
	it("puts nothing back, and leaves nothing aside, when a close for good follows a hand-off before the rename answered", async () => {
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

	it("says nothing when its files went before its record was written", async () => {
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
