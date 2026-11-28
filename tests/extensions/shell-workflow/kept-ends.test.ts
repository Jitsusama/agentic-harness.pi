/**
 * What ends a kept command once the pi that started it has gone.
 *
 * A kept command outlives its pi on purpose, so a move or a restart can
 * carry it, and so it outlived everything: on 28 November 2AF2DH's two
 * test loops ran on 6.5 and 8 hours after their results were read, and
 * four kept `tee` scopes with no record sat 8 to 65 hours in jobs.slice
 * (A210E4CA's finding). Each case here runs a real kept shell, leading
 * its own group with a child in it, and asks whether it still runs.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
} from "vitest";
import {
	type CarriedShellsOptions,
	carriedShells,
	STRAY_FOR_MS,
} from "../../../host/engine/carried-shells.ts";
import type { CarriedShell } from "../../../lib/internal/shell/carried.ts";
import {
	JOB_SUFFIX,
	KEEP_VARIABLE,
	makeKept,
	markCarried,
	ownerMarkOf,
} from "../../../lib/internal/shell/kept.ts";
import {
	type KeptJob,
	recordedKeptJobs,
	strayKeptJobs,
} from "../../../lib/internal/shell/kept-jobs.ts";
import { endOrphanedKept } from "../../../lib/internal/shell/kept-orphans.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";
import { execed, gone, noSuchProcess } from "../../support/processes.ts";
import { until } from "../../support/until.ts";

/** How long a killed process may take to be gone. */
const GONE_WITHIN_MS = 3_000;

/** A kept call's shell, as a host or a pi finds it, and the child it ran. */
interface Kept {
	readonly work: CarriedShell;
	readonly child: number;
}

let root: string;
let folder: string;
let now: number;
let said: string[];
let reported: unknown[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kept-ends-"));
	folder = join(root, "kept");
	now = Date.now();
	said = [];
	reported = [];
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A pi that has gone, as an owner mark names it. */
function goneOwner(): string {
	return `${noSuchProcess()}:1`;
}

/** Whether something still runs as `pid`, and isn't only waiting to be reaped. */
function runs(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return (
			stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
		);
	} catch {
		// Gone from /proc: not running.
		return false;
	}
}

/**
 * A kept call in `where`, run as the stub runs one: a shell leading its
 * own group, with the call's path and mark, and a child without the
 * path, as the stub unsets it for the command.
 */
async function keptCall(owner: string, where = folder): Promise<Kept> {
	const keep = await makeKept(where, owner);
	const mark = randomUUID();
	const childFile = join(root, `${mark}.child`);
	const shell: ChildProcess = spawn(
		"bash",
		[
			"-c",
			`env -u ${KEEP_VARIABLE} sleep 600 & echo $! > "$1"; wait`,
			"kept",
			childFile,
		],
		{
			detached: true,
			env: { ...process.env, [KEEP_VARIABLE]: keep, [CALL_VARIABLE]: mark },
			stdio: "ignore",
		},
	);
	await once(shell, "spawn");
	const pid = shell.pid ?? 0;
	onTestFinished(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Ended by the test, as it should be.
		}
	});
	await execed(pid, "bash");
	await until("the call's child to start", () =>
		/^\d+\n$/.test(
			existsSync(childFile) ? readFileSync(childFile, "utf8") : "",
		),
	);
	const child = Number(readFileSync(childFile, "utf8").trim());
	await execed(child, "sleep");
	writeFileSync(`${keep}.pid`, `${pid}\n`);
	return {
		work: { kind: "shell", keep, pid, mark, startedAt: now },
		child,
	};
}

/** Record `work` as jobs does as it runs, held by the pi at `owner`. */
function record(work: CarriedShell, owner: number, session = "s1"): void {
	const job: KeptJob = {
		session,
		id: "j1",
		kind: "bash",
		label: "make test",
		owner,
		work,
	};
	writeFileSync(`${work.keep}${JOB_SUFFIX}`, JSON.stringify(job), {
		mode: 0o600,
	});
}

/** A host's watch over the kept folder, stopping calls for real. */
function host(overrides: Partial<CarriedShellsOptions> = {}) {
	return carriedShells({
		stateDir: join(root, "host"),
		jobs: "",
		scoped: false,
		ownCgroup: () => "0::/test\n",
		records: (session) => recordedKeptJobs(session, folder),
		recorded: () => strayKeptJobs(folder),
		// Orphans are looked at below on their own.
		orphans: () => Promise.resolve(),
		unclaimed: new Map(),
		say: (line) => said.push(line),
		report: (error) => reported.push(error),
		now: () => now,
		...overrides,
	});
}

/** Wait for a call's shell and its child both to be gone. */
async function ended(kept: Kept): Promise<void> {
	await gone(kept.work.pid, GONE_WITHIN_MS);
	await until(
		`${kept.child} to stop running`,
		() => !runs(kept.child),
		GONE_WITHIN_MS,
	);
}

function bothRun(kept: Kept): boolean {
	return runs(kept.work.pid) && runs(kept.child);
}

describe.runIf(existsSync("/proc/self/environ"))("a kept command", () => {
	it("is taken up as its conversation restarts, or ended when nothing took it up", async () => {
		const taken = await keptCall(ownerMarkOf());
		record(taken.work, process.pid);
		const left = await keptCall(goneOwner());
		record(left.work, noSuchProcess());
		await host().started("s1");
		await ended(left);
		expect(bothRun(taken), "the one its conversation took up runs on").toBe(
			true,
		);
		expect(said.sort()).toEqual([
			expect.stringMatching(
				/^Stopped `make test` \(j1 of s1\).*started here without taking it up/,
			),
			expect.stringMatching(/^Took up `make test` \(j1 of s1\)/),
		]);
		expect(reported).toEqual([]);
	});

	it("ends with its whole group once no host takes it up within the bound", async () => {
		const kept = await keptCall(goneOwner());
		record(kept.work, noSuchProcess());
		const shells = host();
		await shells.look(() => false);
		expect(bothRun(kept), "not at the first sight of it").toBe(true);
		now += STRAY_FOR_MS - 1;
		await shells.look(() => false);
		expect(bothRun(kept), "nor before the bound").toBe(true);
		now += 1;
		await shells.look(() => false);
		await ended(kept);
		expect(said).toEqual([
			expect.stringMatching(/make test.*no host took it up within 10 minutes/),
		]);
		expect(reported).toEqual([]);
	});

	it("ends with its whole group when found with no record and its pi gone", async () => {
		const kept = await keptCall(goneOwner());
		const found = await endOrphanedKept({
			folder,
			say: (line) => said.push(line),
		});
		await ended(kept);
		expect(found.map((each) => each.keep)).toEqual([kept.work.keep]);
		expect(said).toEqual([
			expect.stringMatching(
				/^Ended kept call .*: the pi that started it has gone/,
			),
		]);
	});

	it("ends when found with its files gone", async () => {
		const kept = await keptCall(goneOwner());
		for (const suffix of [".owner", ".pid", ".out", ".end"])
			rmSync(`${kept.work.keep}${suffix}`);
		await endOrphanedKept({ folder });
		await ended(kept);
	});

	it("is spared while carried, by a host that holds the carry and by the look for orphans", async () => {
		const recorded = await keptCall(goneOwner());
		record(recorded.work, noSuchProcess());
		markCarried(recorded.work.keep);
		const unrecorded = await keptCall(goneOwner());
		markCarried(unrecorded.work.keep);
		const shells = host();
		await shells.look(() => true);
		now += STRAY_FOR_MS;
		await shells.look(() => true);
		await endOrphanedKept({ folder });
		expect(bothRun(recorded), "the recorded call, carried").toBe(true);
		expect(bothRun(unrecorded), "the unrecorded call, carried").toBe(true);
		expect(said).toEqual([]);
	});

	it("from before owners were named, ends once its shell is gone, unless counted in another pid namespace", async () => {
		/** A call whose pi named no owner, with its shell's pid naming nothing here. */
		const ownerless = async (): Promise<Kept> => {
			const kept = await keptCall(goneOwner());
			rmSync(`${kept.work.keep}.owner`);
			writeFileSync(`${kept.work.keep}.pid`, `${noSuchProcess()}\n`);
			return kept;
		};
		const fenced = await ownerless();
		await endOrphanedKept({ folder, sharesPids: () => false });
		expect(
			bothRun(fenced),
			"a fenced pi's, whose pid proves nothing here",
		).toBe(true);
		await endOrphanedKept({ folder });
		await ended(fenced);
	});

	it("is spared while the pi that started it runs, or when it isn't the kept folder's own", async () => {
		const own = await keptCall(ownerMarkOf());
		const deeper = join(folder, "deeper");
		mkdirSync(deeper, { recursive: true });
		const elsewhere = await keptCall(goneOwner(), deeper);
		await endOrphanedKept({ folder });
		expect(bothRun(own), "its pi runs").toBe(true);
		expect(bothRun(elsewhere), "not in the kept folder itself").toBe(true);
	});
});
