/**
 * Each bash call keeps its output, status and pid on disk while it runs,
 * through the keeping stub, on a real bash: what pi reads is what it
 * read before, even when its tee is slow to write it, a call that ends
 * in its pi takes its files with it, and one handed on leaves them, its
 * status written whatever the command did on its way out, and all it
 * says once whatever read it has gone.
 */

import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashOperations,
	createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COMMAND_STUB,
	COMMAND_VARIABLE,
	KEEP_VARIABLE,
} from "../../../extensions/shell-workflow/command-line.ts";
import { keepsOnDisk } from "../../../extensions/shell-workflow/keeping.ts";
import { isCarriedShell } from "../../../lib/internal/shell/carried.ts";
import { endOf, outputOf } from "../../../lib/internal/shell/kept.ts";
import {
	forgetKeptJob,
	recordKeptJob,
} from "../../../lib/internal/shell/kept-jobs.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";
import { until } from "../../support/until.ts";

// Each move and removal off the thread, which can be held after the disk
// acts, as a busy disk's callback comes late; and each synchronous call
// that could stall the thread, by the path asked.
const disk = vi.hoisted(() => {
	let held: Promise<void> | undefined;
	let release: () => void = () => undefined;
	return {
		moved: [] as string[],
		removed: [] as string[],
		asked: [] as string[],
		hold(): void {
			held = new Promise((done) => {
				release = done;
			});
		},
		go(): void {
			held = undefined;
			release();
		},
		async pass(): Promise<void> {
			if (held !== undefined) await held;
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const rename = (async (...args: Parameters<typeof real.rename>) => {
		disk.moved.push(String(args[0]));
		await real.rename(...args);
		await disk.pass();
	}) as typeof real.rename;
	const rm = (async (...args: Parameters<typeof real.rm>) => {
		disk.removed.push(String(args[0]));
		await real.rm(...args);
		await disk.pass();
	}) as typeof real.rm;
	const mocked = { ...real, rename, rm };
	return { ...mocked, default: mocked };
});

// Every synchronous call, and the callback forms a stall could hide in
// as easily, so a new one on the thread is heard whatever it is.
vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const callbacks = ["stat", "lstat", "access", "unlink", "open", "readFile"];
	const mocked = {
		...real,
		...heard(
			real,
			Object.keys(real).filter(
				(name) => name.endsWith("Sync") || callbacks.includes(name),
			),
		),
	};
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

const made: string[] = [];
afterEach(() => {
	disk.go();
	disk.moved.length = 0;
	disk.removed.length = 0;
	disk.asked.length = 0;
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** Keeping operations over real bash, their files in a folder of their own. */
function keeping() {
	const dir = mkdtempSync(join(tmpdir(), "keeping-"));
	made.push(dir);
	const folder = join(dir, "kept");
	return {
		folder,
		...keepsOnDisk(createLocalBashOperations(), {
			can: () => true,
			folder: () => folder,
		}),
	};
}

/**
 * A folder whose `tee` waits `seconds` before it starts, as one does on a
 * machine too busy to run it at once.
 */
function slowTee(seconds: number): string {
	const dir = mkdtempSync(join(tmpdir(), "slow-tee-"));
	made.push(dir);
	const tee = execFileSync("sh", ["-c", "command -v tee"], {
		encoding: "utf8",
	}).trim();
	const file = join(dir, "tee");
	writeFileSync(file, `#!/bin/sh\nsleep ${seconds}\nexec ${tee} "$@"\n`);
	chmodSync(file, 0o755);
	return dir;
}

/**
 * Operations that read a call's output until `leave` is called, then close
 * their end of its pipes and return with the call still running, as a
 * pi-spawner that leaves kept commands running does when its pi goes.
 */
function readsUntilItLeaves() {
	let leave = (): void => undefined;
	const left = new Promise<void>((resolve) => {
		leave = resolve;
	});
	const operations: BashOperations = {
		async exec(command, cwd, call) {
			const child = spawn("bash", ["-c", command], {
				cwd,
				env: call.env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			child.stdout.on("data", call.onData);
			child.stderr.on("data", call.onData);
			await left;
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			return { exitCode: null };
		},
	};
	return { operations, leave };
}

/** Run `command` as the spawn hook leaves it, collecting what pi reads. */
async function run(
	ops: ReturnType<typeof keeping>["operations"],
	command: string,
	signal: AbortSignal = new AbortController().signal,
	env: Readonly<Record<string, string>> = {},
	timeout?: number,
) {
	let read = "";
	const result = await ops.exec(COMMAND_STUB, tmpdir(), {
		onData: (data) => {
			read += data.toString();
		},
		signal,
		...(timeout !== undefined ? { timeout } : {}),
		env: {
			...process.env,
			[COMMAND_VARIABLE]: command,
			[CALL_VARIABLE]: "mark-1",
			...env,
		},
	});
	return { code: result.exitCode, read };
}

describe("a kept call", () => {
	it("reads as it did and leaves nothing once it ends in its pi", async () => {
		const kept = keeping();
		const { code, read } = await run(
			kept.operations,
			"echo out; echo err >&2; exit 3",
		);
		expect(code).toBe(3);
		expect(read.split("\n").sort()).toEqual(["", "err", "out"]);
		await vi.waitFor(() =>
			expect(readdirSync(kept.folder), "its files go just after").toEqual([]),
		);
	});

	it("ends only once its tee has written what it said", async () => {
		const kept = keeping();
		const { read } = await run(
			kept.operations,
			"echo out",
			new AbortController().signal,
			{ PATH: `${slowTee(0.3)}:${process.env.PATH ?? ""}` },
		);
		expect(read, "pi read it before the shell had gone").toBe("out\n");
	});

	it("isn't held by what it left writing to its output", async () => {
		const kept = keeping();
		const started = Date.now();
		const { code, read } = await run(kept.operations, "sleep 5 & echo out");
		expect(code).toBe(0);
		expect(read).toBe("out\n");
		expect(Date.now() - started, "ended well before its child").toBeLessThan(
			3000,
		);
	});

	it("is not kept where it can't be", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keeping-"));
		made.push(dir);
		const folder = join(dir, "kept");
		const off = keepsOnDisk(createLocalBashOperations(), {
			can: () => false,
			folder: () => folder,
		});
		const signal = new AbortController().signal;
		expect((await run(off.operations, "echo out", signal)).read).toBe("out\n");
		expect(off.carryOf(signal), "nothing to carry it by").toBeUndefined();
	});

	it("leaves its files when handed on, its status written past its own exit trap", async () => {
		const kept = keeping();
		const signal = new AbortController().signal;
		const running = run(
			kept.operations,
			"trap 'echo bye' EXIT; echo started; sleep 0.3; exit 4",
			signal,
		);
		const carry = kept.carryOf(signal);
		await until(
			"the call to have its pid on disk",
			() => carry?.what() !== undefined,
		);
		const work = carry?.what();
		if (!isCarriedShell(work)) throw new Error(`carried as ${String(work)}`);
		expect(work.mark).toBe("mark-1");
		carry?.handed();
		expect(
			existsSync(`${work.keep}.carried`),
			"marked carried, so a host's reaper spares it",
		).toBe(true);
		expect(
			readFileSync(`${work.keep}.carried`, "utf8"),
			"by the call's mark, which all it starts inherits",
		).toBe("mark-1");
		expect((await running).code).toBe(4);
		expect(endOf(work.keep), "its status is on disk").toBe(4);
		expect(outputOf(work.keep)).toBe("started\nbye\n");
		expect(
			Number(readFileSync(`${work.keep}.pid`, "utf8")),
			"its shell's pid is on disk",
		).toBe(work.pid);
		expect(
			carry?.what(),
			"once handed, it isn't carried twice",
		).toBeUndefined();
	});

	it("outlives its time limit here once handed on, the pi that took it up holding it", async () => {
		const kept = keeping();
		const signal = new AbortController().signal;
		const running = run(
			kept.operations,
			"echo started; sleep 0.8; exit 5",
			signal,
			{},
			0.3,
		);
		const carry = kept.carryOf(signal);
		await until(
			"the call to have its pid on disk",
			() => carry?.what() !== undefined,
		);
		const work = carry?.what();
		if (!isCarriedShell(work)) throw new Error(`carried as ${String(work)}`);
		expect(work.deadline, "the deadline goes with it").toBeDefined();
		carry?.handed();
		expect(
			(await running).code,
			"not killed at a limit that's no longer this pi's",
		).toBe(5);
		expect(endOf(work.keep), "its own end is on disk").toBe(5);
	});

	it("times out as pi says while it is still this pi's", async () => {
		const kept = keeping();
		const started = Date.now();
		await expect(
			run(kept.operations, "sleep 5", new AbortController().signal, {}, 0.3),
		).rejects.toThrow("timeout:0.3");
		expect(Date.now() - started, "stopped at its limit").toBeLessThan(3000);
		await vi.waitFor(() =>
			expect(readdirSync(kept.folder), "its files go just after").toEqual([]),
		);
	});

	it("writes all it says once what read it has gone, as a spawner leaving it does", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keeping-"));
		made.push(dir);
		const folder = join(dir, "kept");
		const reader = readsUntilItLeaves();
		const kept = keepsOnDisk(reader.operations, {
			can: () => true,
			folder: () => folder,
		});
		const signal = new AbortController().signal;
		const running = run(
			kept.operations,
			"echo tick-1; sleep 0.3; for i in 2 3 4 5 6; do echo tick-$i; done; exit 7",
			signal,
		);
		const carry = kept.carryOf(signal);
		await until(
			"the call to have its pid on disk",
			() => carry?.what() !== undefined,
		);
		const work = carry?.what();
		if (!isCarriedShell(work)) throw new Error(`carried as ${String(work)}`);
		carry?.handed();
		await until("its first line on disk", () =>
			outputOf(work.keep).startsWith("tick-1\n"),
		);
		reader.leave();
		expect((await running).code, "its reader went before it ended").toBeNull();
		await until("its end on disk", () => endOf(work.keep) !== undefined);
		expect(endOf(work.keep), "its own status, not a broken pipe's").toBe(7);
		expect(
			outputOf(work.keep),
			"every line, those after its reader went too",
		).toBe("tick-1\ntick-2\ntick-3\ntick-4\ntick-5\ntick-6\n");
	});

	// A job is said ended only once its call settles, and a move or a
	// shutdown meeting one neither carriable nor ended would drop it.
	it("is said ended at once, and can't be carried or handed on while its files go", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keeping-"));
		made.push(dir);
		const folder = join(dir, "kept");
		const signal = new AbortController().signal;
		let ended = false;
		const seen: unknown[] = [];
		// Asks after the call each turn of the loop from the moment its shell
		// ends, as a move arriving then would.
		const ask = () => {
			if (!ended) return;
			const carry = kept.carryOf(signal);
			const work = carry?.what();
			if (work !== undefined) {
				seen.push(work);
				carry?.handed();
			}
			setImmediate(ask);
		};
		const kept = keepsOnDisk(
			{
				async exec(_command, _cwd, call) {
					const keep = call.env?.[KEEP_VARIABLE];
					writeFileSync(`${keep}.pid`, String(process.pid));
					writeFileSync(`${keep}.end`, "0");
					ended = true;
					setImmediate(ask);
					return { exitCode: 0 };
				},
			},
			{ can: () => true, folder: () => folder },
		);
		await run(kept.operations, "true", signal);
		expect(
			readdirSync(folder).length,
			"said ended before its files go",
		).toBeGreaterThan(0);
		await vi.waitFor(() =>
			expect(readdirSync(folder), "its files go just after").toEqual([]),
		);
		ended = false;
		expect(seen, "nothing to carry once it ended here").toEqual([]);
	});

	// A pi gone between the settle and the record's removal would leave a
	// job its next start takes up and says the end of a second time.
	it("takes back its job's record before it settles, waiting for the disk", async () => {
		const call = endsRecorded();
		disk.hold();
		let settled = false;
		const running = run(call.kept.operations, "true", call.signal).then(
			(result) => {
				settled = true;
				return result;
			},
		);
		await until("its record unlinked", () => call.recordGone());
		await turns(5);
		expect(settled, "unsettled while the disk holds the removal").toBe(false);
		disk.go();
		await running;
		expect(call.recordGone(), "its record, as it settles").toBe(true);
		await vi.waitFor(() =>
			expect(readdirSync(call.folder), "its files go just after").toEqual([]),
		);
	});

	// Its shell has ended, so waiting longer would only hold the stop the
	// person asked for.
	it("settles at once when stopped while its record goes", async () => {
		const call = endsRecorded();
		disk.hold();
		const running = run(call.kept.operations, "true", call.signal).then(
			() => "settled",
			() => "settled",
		);
		await until("its record unlinked", () => call.recordGone());
		await turns(5);
		call.stop();
		expect(
			await Promise.race([running, settlesWithin()]),
			"settled while the disk holds its record's removal",
		).toBe("settled");
		disk.go();
		await vi.waitFor(() =>
			expect(readdirSync(call.folder), "its files go just after").toEqual([]),
		);
	});

	// A move or a host's stop meeting a job neither carriable nor ended
	// leaves it behind and stops it, its real status never said.
	it("can still be carried while its record goes", async () => {
		const call = endsRecorded();
		disk.hold();
		const running = run(call.kept.operations, "true", call.signal);
		await until("its record unlinked", () => call.recordGone());
		const work = call.kept.carryOf(call.signal)?.what();
		expect(isCarriedShell(work), "carriable while it goes").toBe(true);
		disk.go();
		await running;
		expect(
			call.kept.carryOf(call.signal)?.what(),
			"nothing to carry once settled here",
		).toBeUndefined();
	});

	// Carried then, its taker would find a shell gone with no end, and
	// say it was lost rather than stopped.
	it("can't be carried while its record goes once this pi stopped it", async () => {
		const call = endsRecorded({ stops: true });
		disk.hold();
		const running = run(call.kept.operations, "true", call.signal).then(
			() => "settled",
			() => "settled",
		);
		await until("its record unlinked", () => call.recordGone());
		expect(
			call.kept.carryOf(call.signal)?.what(),
			"nothing to carry: its stop is said here",
		).toBeUndefined();
		// Stopped, it waits on no disk: its record, left, reads as a call
		// gone with no end, which nothing takes up.
		expect(
			await Promise.race([running, settlesWithin()]),
			"settled while the disk holds its record's removal",
		).toBe("settled");
		disk.go();
		await vi.waitFor(() =>
			expect(readdirSync(call.folder), "its files go just after").toEqual([]),
		);
		// Its files' removal takes the record; a second, setting it aside,
		// would only wait on the same disk and say it waited.
		expect(
			disk.moved.filter((path) => path.startsWith(call.keep())),
			"its record removed, never set aside",
		).toEqual([]);
	});

	// Its limit stops it with the caller's own signal still live, so only
	// the stop of this pi's own tells it from a call that ended.
	it("can't be carried while its record goes once its time limit stopped it", async () => {
		const call = endsRecorded({ hangs: true });
		disk.hold();
		const said = run(call.kept.operations, "true", call.signal, {}, 0.3).then(
			() => "settled",
			(error: unknown) => String(error),
		);
		await until("its record unlinked", () => call.recordGone());
		expect(
			call.kept.carryOf(call.signal)?.what(),
			"nothing to carry: its time limit is said here",
		).toBeUndefined();
		expect(
			await Promise.race([said, settlesWithin()]),
			"it times out as pi says, while the disk holds its record's removal",
		).toContain("timeout:0.3");
		disk.go();
		await vi.waitFor(() =>
			expect(readdirSync(call.folder), "its files go just after").toEqual([]),
		);
		expect(
			disk.moved.filter((path) => path.startsWith(call.keep())),
			"its record removed, never set aside",
		).toEqual([]);
	});

	it("leaves its files to whoever it was handed to while its record went", async () => {
		const call = endsRecorded();
		disk.hold();
		const running = run(call.kept.operations, "true", call.signal);
		await until("its record set aside", () => call.recordGone());
		call.kept.carryOf(call.signal)?.handed();
		// The move that hands it on closes the giving session in that turn.
		forgetKeptJob(call.keep());
		disk.go();
		await running;
		expect(
			disk.moved.filter((path) => path.startsWith(call.keep())),
			"only its record set aside, none of its other files",
		).toEqual([`${call.keep()}.job`]);
		expect(
			removedOf(call.keep()),
			"none of its files asked to go: they are the taker's",
		).toEqual([]);
		expect(existsSync(`${call.keep()}.end`), "its end, for the taker").toBe(
			true,
		);
		expect(existsSync(`${call.keep()}.job`), "its record, put back").toBe(true);
	});

	// A reload hands the call on in this same process, closes the giving
	// session, and the session that takes it up writes its record again
	// while the first removal runs.
	it("leaves the record its taker writes while its own went", async () => {
		const call = endsRecorded();
		disk.hold();
		const running = run(call.kept.operations, "true", call.signal);
		await until("its record set aside", () => call.recordGone());
		call.kept.carryOf(call.signal)?.handed();
		forgetKeptJob(call.keep());
		call.record("taken up");
		disk.go();
		await running;
		expect(
			removedOf(call.keep()),
			"none of its files asked to go, the taker's record among them",
		).toEqual([]);
		expect(
			JSON.parse(readFileSync(`${call.keep()}.job`, "utf8")).label,
			"the taker's record",
		).toBe("taken up");
	});

	// Most calls record no job: their end waits on no disk at all, and asks
	// it nothing on the thread, which under load held every conversation's
	// loop for seconds.
	it("settles though the disk holds every removal, when it recorded no job", async () => {
		const call = endsRecorded({ records: false });
		disk.hold();
		// A bound on the settle, so one that waits on the disk fails here,
		// saying so, rather than at the test's timeout.
		const bound = new Promise<"held">((done) =>
			setTimeout(() => done("held"), SETTLES_IN_MS),
		);
		const result = await Promise.race([
			run(call.kept.operations, "true", call.signal),
			bound,
		]);
		expect(result, "settled with its status").toMatchObject({ code: 0 });
		expect(
			disk.asked.filter((said) => said.includes(`${call.keep()}.job`)),
			"nothing asked of its record on the thread",
		).toEqual([]);
		expect(
			disk.moved.filter((path) => path.startsWith(`${call.keep()}.job`)),
			"nor set aside off it",
		).toEqual([]);
	});
});

/**
 * How long a call whose disk is held is given to settle: under the 5 s a
 * call waits for its record's removal, so one that waits on the disk at
 * all fails, and within a test's own timeout, so it fails as itself.
 */
const SETTLES_IN_MS = 2_000;

/** Answers "held" once `SETTLES_IN_MS` passes, the bound on a settle. */
function settlesWithin(): Promise<"held"> {
	return new Promise((done) => setTimeout(() => done("held"), SETTLES_IN_MS));
}

/**
 * The call's files kept at `keep` that a removal was asked for, by their
 * own names, not an aside's. The first is asked as its removal starts,
 * before the call settles, so none is missed by a check just after.
 */
function removedOf(keep: string): string[] {
	const own = [".job", ".end", ".pid"].map((suffix) => `${keep}${suffix}`);
	return disk.removed.filter((path) => own.includes(path));
}

/** Let `count` turns of the loop pass, for what would run in them. */
async function turns(count: number): Promise<void> {
	for (let turn = 0; turn < count; turn += 1) {
		await new Promise((done) => setImmediate(done));
	}
}

/**
 * A kept call whose shell ends at once with status 0, its job recorded
 * as a job's recorder records one in this process, unless `records` is
 * false. With `stops`, pi stops it as it runs, and its shell writes no
 * end. With `hangs`, its shell runs until it is stopped, writing no end.
 */
function endsRecorded({
	records = true,
	stops = false,
	hangs = false,
}: {
	records?: boolean;
	stops?: boolean;
	hangs?: boolean;
} = {}) {
	const stopping = new AbortController();
	const dir = mkdtempSync(join(tmpdir(), "keeping-"));
	made.push(dir);
	const folder = join(dir, "kept");
	let keep = "";
	const record = (label: string) =>
		recordKeptJob({
			session: "s1",
			id: "j1",
			kind: "shell",
			label,
			work: {
				kind: "shell",
				keep,
				pid: process.pid,
				mark: "mark-1",
				startedAt: Date.now(),
			},
		});
	const kept = keepsOnDisk(
		{
			async exec(_command, _cwd, call) {
				keep = call.env?.[KEEP_VARIABLE] ?? "";
				writeFileSync(`${keep}.pid`, String(process.pid));
				if (records) record("true");
				if (stops) {
					stopping.abort();
					return { exitCode: null };
				}
				if (hangs) {
					await new Promise((done) =>
						call.signal?.addEventListener("abort", done, { once: true }),
					);
					return { exitCode: null };
				}
				writeFileSync(`${keep}.end`, "0");
				return { exitCode: 0 };
			},
		},
		{ can: () => true, folder: () => folder },
	);
	return {
		folder,
		kept,
		signal: stopping.signal,
		keep: () => keep,
		/** Stop the call, as the person pressing stop does. */
		stop: () => stopping.abort(),
		/** Record the call's job again, as one taking it up does. */
		record,
		recordGone: () => keep !== "" && !existsSync(`${keep}.job`),
	};
}
