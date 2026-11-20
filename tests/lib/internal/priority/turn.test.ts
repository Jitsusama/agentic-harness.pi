import { spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queueFolder } from "../../../../lib/internal/priority/folder.ts";
import {
	HEADROOM,
	keepOutcome,
	outcomeOf,
} from "../../../../lib/internal/priority/outcome.ts";
import { pushesFolder } from "../../../../lib/internal/priority/pushes.ts";
import {
	CHANGED_CHECKS_GIB,
	CHANGED_CHECKS_SENT_GIB,
	EVAL_TESTS_GIB,
	EVERY_CHECK_GIB,
	PUSH_GIB,
} from "../../../../lib/internal/priority/queue.ts";
import type { Reading } from "../../../../lib/internal/priority/room.ts";
import {
	inSharedSlice,
	SLICE_GIVEN_UP,
} from "../../../../lib/internal/priority/shared-slice.ts";
import {
	queuedCommand,
	queueHeavyWork,
	waitsForTurn,
} from "../../../../lib/internal/priority/turn.ts";

/** A job as the queue writes it down. */
type Job = Parameters<typeof outcomeOf>[0];

const ROOMY: Reading = {
	availableGib: 40,
	memoryPressure: 0,
	vms: 0,
	cpuPressure: 0,
	cores: 16,
	pressure: { cpu: 0, memory: 0, io: 0 },
};

let root: string;
let dir: string;
let undo: (() => void) | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "turn-"));
	dir = join(root, "jobs");
	mkdirSync(dir);
	writeFileSync(join(dir, "queue.json"), "{}\n");
});
afterEach(() => {
	undo?.();
	undo = undefined;
	rmSync(root, { recursive: true, force: true });
});

function queueing(room: Reading) {
	const folder = queueFolder(dir, {
		isRunning: () => true,
		cgroupOf: () => undefined,
	});
	undo = queueHeavyWork({
		folder,
		session: "session-a",
		room: () => room,
		cgroupFor: () => join(root, "timed"),
	});
	return folder;
}

/** Runs `command` in bash, resolving with what it said and its exit code. */
function run(command: string): Promise<{ out: string; code: number | null }> {
	return new Promise((resolve) => {
		const shell = spawn("bash", ["-c", command]);
		let out = "";
		shell.stdout.on("data", (data) => {
			out += data;
		});
		shell.stderr.on("data", (data) => {
			out += data;
		});
		shell.on("exit", (code) => resolve({ out, code }));
	});
}

const jobIds = () =>
	readdirSync(dir)
		.filter((name) => name.endsWith(".job"))
		.map((name) => name.slice(0, -4));

/** Every job asked for, as it was written down. */
const jobsAsked = () =>
	jobIds().map((id) =>
		JSON.parse(readFileSync(join(dir, `${id}.job`), "utf8")),
	);

/**
 * Keep a run of this session's from before, taking `tookMs` and ending
 * with `exit`, where the queue reads how its work last went. What was
 * `seen` of it, when given, is written over what the run says.
 */
async function ranBefore(
	job: Pick<Job, "kind" | "what"> & Partial<Job>,
	tookMs: number,
	exit = 0,
	seen: Partial<ReturnType<typeof outcomeOf>> = {},
): Promise<void> {
	const ran = new Date().toISOString();
	await keepOutcome(join(root, "outcomes.jsonl"), {
		...outcomeOf(
			{
				id: "before",
				owner: { session: "session-a", pid: 1 },
				since: ran,
				started: ran,
				...job,
			},
			Date.parse(ran) + tookMs,
			exit,
		),
		...seen,
	});
}

/** Queue this session's heavy work, reading the runs kept before it. */
function queueingAfterRuns(
	more: Partial<Parameters<typeof queueHeavyWork>[0]> = {},
): void {
	undo = queueHeavyWork({
		folder: queueFolder(
			dir,
			{ isRunning: () => true, cgroupOf: () => undefined },
			undefined,
			join(root, "outcomes.jsonl"),
		),
		session: "session-a",
		room: () => ROOMY,
		cgroupFor: () => undefined,
		...more,
	});
}

describe("heavy work waiting for its turn", () => {
	it("leaves light work, and all work with no queue kept, as it was", () => {
		expect(queuedCommand("cargo build")).toBe("cargo build");
		queueing(ROOMY);
		expect(queuedCommand("git status")).toBe("git status");
		expect(jobIds()).toEqual([]);
	});

	it("asks as a VM check for work whose builds last ran one", async () => {
		await ranBefore(
			{
				kind: "build",
				what: "nix flake check --keep-going",
				ranTimed: true,
			},
			0,
		);
		queueingAfterRuns();
		queuedCommand("nix flake check --keep-going");
		queuedCommand("nix build .#tool");
		const kinds = jobsAsked()
			.map((job) => [job.what, job.kind])
			.sort();
		expect(kinds).toEqual([
			["nix build .#tool", "build"],
			["nix flake check --keep-going", "vm-check"],
		]);
	});

	it("asks a walk of World's objects from the folder it runs in, held to 6 GiB", async () => {
		// A walk's own scope is charged only the pages it read in first, so
		// what it was seen to hold says little of the packs it maps.
		const fetch = "git fetch origin someone/branch";
		await ranBefore(
			{
				kind: "world-walk",
				what: fetch,
				ownedPeakBytes: 0.5 * 1024 ** 3,
			},
			300_000,
		);
		queueingAfterRuns();
		const world = join(homedir(), "world", "trees", "w-main", "src");
		expect(queuedCommand(fetch, join(homedir(), "src"))).toBe(fetch);
		expect(jobIds()).toEqual([]);
		queuedCommand(fetch, world);
		const [job] = jobsAsked();
		expect(job).toMatchObject({
			kind: "world-walk",
			what: fetch,
			needsGib: 6,
		});
		expect(job.planning).toBeUndefined();
		expect(job.quick).toBeUndefined();
	});

	it("gives up the shared slice for a walk that fits alone but not with the queue's lines", () => {
		queueingAfterRuns();
		const world = join(homedir(), "world", "trees", "w-main", "src");
		// Linux's one string, less the room kept after the queue; the form
		// holds the command twice.
		const room = 128 * 1024 - 4 * 1024;
		const start = "git fetch origin ";
		const bare = Buffer.byteLength(inSharedSlice(start));
		const fetch = `${start}${"x".repeat(Math.floor((room - bare) / 2))}`;
		expect(inSharedSlice(fetch), "alone it fits the slice").toContain(
			"systemd-run",
		);

		const queued = queuedCommand(fetch, world);

		expect(jobsAsked().length, "queued as a walk").toBe(1);
		expect(queued, "with the queue's lines it doesn't").toContain(
			// Up to its apostrophe, which the shell text quotes.
			SLICE_GIVEN_UP.split("'")[0],
		);
	});

	// 10 November: four pushes of World peaked at 2.9 to 3.2 MB and ran 3
	// to 14 s, and each waited 481 to 618 s booked as a 6 GiB walk. With
	// the LFS scan left out a push reads a few commits, not the packs.
	it("asks a push of World that leaves out its LFS scan for what it holds, as quick work", async () => {
		await ranBefore(
			{
				kind: "world-walk",
				what: "git push origin seen",
				ownedPeakBytes: 1.5 * 1024 ** 3,
			},
			7_000,
		);
		queueingAfterRuns();
		const world = join(homedir(), "world", "trees", "w-main", "src");
		queuedCommand("git push origin seen", world);
		queuedCommand("git push origin new", world);

		const booked = jobsAsked()
			.map((job) => [job.what, job.needsGib, job.quick, job.walk])
			.sort();
		expect(booked).toEqual([
			["git push origin new", PUSH_GIB, true, "push"],
			["git push origin seen", Math.ceil(1.5 * HEADROOM), true, "push"],
		]);
	});

	it("asks a chain ending in a zone's evaluation tests for theirs, whatever its earlier runs held", async () => {
		// Runs stopped by a failing cargo test never reached nix-unit, so
		// they held a build's memory; on 6 November the one that did was
		// killed at 8.5 GiB against the 4 it was held to.
		const tests = "tec run //system/aquifer/converge:evalTests";
		const chain = `cargo test && ${tests}`;
		await ranBefore(
			{
				kind: "build",
				what: tests,
				ownedPeakBytes: 1024 ** 3,
			},
			300_000,
			101,
		);
		queueingAfterRuns();
		queuedCommand(chain);
		queuedCommand("cargo test");
		const booked = jobsAsked()
			.map((job) => [job.what, job.needsGib])
			.sort();
		// Named by its evaluation tests, so its peak isn't charged to every
		// plain `cargo test`.
		expect(booked).toEqual([
			["cargo test", 4],
			[tests, EVAL_TESTS_GIB],
		]);
	});

	it("asks a fetch of main as one, reading origin/main as it runs, or answered", () => {
		queueing(ROOMY);
		const world = join(homedir(), "world", "trees", "w-main", "src");
		const fetching = queuedCommand(
			"git fetch -q origin main 2>&1 | tail -2",
			world,
		);
		const pushing = queuedCommand("git push origin x", world);
		const jobs = jobsAsked();
		const fetch = jobs.find((job) => job.what.startsWith("git fetch"));
		const push = jobs.find((job) => job.what.startsWith("git push"));
		expect(fetch).toMatchObject({ kind: "world-walk", walk: "main-fetch" });
		expect(push).toMatchObject({ kind: "world-walk", walk: "push" });
		const git = join(homedir(), "world", "git");
		expect(fetching).toContain(
			`.fetched" ]; then PATH="$__queue/fetched:$PATH"`,
		);
		expect(fetching).toContain(`--git-dir='${git}'`);
		expect(fetching).toContain(`${fetch.id}.main-before`);
		expect(fetching).toContain(`${fetch.id}.main-after`);
		expect(pushing).not.toContain(".fetched");
		expect(pushing).not.toContain("main-before");
		expect(pushing).toContain(
			`"GIT_CONFIG_VALUE_$PI_PUSH_HOOKS_PRIOR=${pushesFolder(dir)}"`,
		);
		expect(fetching).not.toContain("core.hooksPath");
		for (const walk of [fetching, pushing]) {
			expect(walk).toContain('--slice="$SHARED_SLICE"');
		}
	});

	it("runs an answered fetch's git from the queue's folder, and reads main around one that is not", () => {
		const world = join(root, "world", "git");
		const wait = waitsForTurn(dir);
		for (const name of ["j5.job", "j5.turn"]) {
			writeFileSync(join(dir, name), "");
		}
		mkdirSync(join(dir, "fetched"));
		writeFileSync(join(dir, "fetched", "git"), "#!/bin/sh\necho answered\n", {
			mode: 0o755,
		});
		const fresh = spawnSync("bash", ["-c", `${wait?.("j5", [], world)}\ngit`], {
			timeout: 10_000,
		});
		expect(fresh.stdout.toString()).not.toContain("answered");
		expect(readdirSync(dir)).toContain("j5.main-before");
		expect(readdirSync(dir)).toContain("j5.main-after");
		writeFileSync(join(dir, "j5.fetched"), "fetching\n");
		const answered = spawnSync(
			"bash",
			["-c", `${wait?.("j5", [], world)}\ngit fetch origin main`],
			{ timeout: 10_000 },
		);
		expect(answered.stdout.toString()).toBe("answered\n");
	});

	it("asks for the memory its whole step needs, past where its name is cut", () => {
		// On 24 October an evaluation of every check on a commit's flake
		// was held to a build's 4 GiB, its `#checks` past the cut.
		queueing(ROOMY);
		const rev = "fbbe51d2220badda56d82cfc6b681cd0213876c8";
		queuedCommand(
			`nix eval --json "git+file:///home/jitsusama/.local/state/pi/agentic-harness.pi/work/trees/worktree-github-Jitsusama-core.nix-main?rev=${rev}#checks.x86_64-linux" --apply 'builtins.mapAttrs (n: v: v.drvPath)' > drvs.json`,
		);
		const [job] = jobsAsked();
		expect(job.what).not.toContain("#checks");
		expect(job.needsGib).toBe(EVERY_CHECK_GIB);
	});

	it("asks for the memory it held when it last ran, with headroom", async () => {
		// On 26 October `nix develop -c cargo test` peaked at 10.9 GiB
		// while held to a build's 4.
		await ranBefore(
			{
				kind: "build",
				what: 'nix develop "path:$d" -c cargo test > $W/logs/one.log 2>&1',
				ownedPeakBytes: 10.9 * 1024 ** 3,
			},
			300_000,
		);
		queueingAfterRuns();
		queuedCommand('nix develop "path:$d" -c cargo test > $W/logs/two.log 2>&1');
		const [job] = jobsAsked();
		expect(job.needsGib).toBe(Math.ceil(10.9 * HEADROOM));
	});

	it("says how long its work took when it last ran, and nothing for new work", async () => {
		// The queue reads when a long run's memory is due back from this.
		await ranBefore(
			{
				kind: "vm-check",
				what: "timeout 9000 direnv exec . changed-checks --build > $T/one.log",
			},
			6_402_000,
		);
		queueingAfterRuns({
			room: () => ({ ...ROOMY, availableGib: 0 }),
		});
		queuedCommand(
			"timeout 9000 direnv exec . changed-checks --build > $T/two.log",
		);
		queuedCommand("cargo test --offline");
		const asked = jobsAsked()
			.map((job) => [job.what, job.lastRanS])
			.sort();
		expect(asked).toEqual([
			["cargo test --offline", undefined],
			["timeout 9000 direnv exec . changed-checks --build > $T/two.log", 6_402],
		]);
	});

	it("asks for the memory of its heaviest step, not its first", () => {
		// Y9XISP's on 24 October: the tool's build came first, so the job
		// was held to a build's 4 GiB while the tool it built used 11.8.
		queueing(ROOMY);
		queuedCommand(
			'cd $T && rev=$(git rev-parse HEAD); out=$(nix build --no-link --print-out-paths "git+file://$PWD?rev=$rev#checks.x86_64-linux.changed-checks-names-what-moved") && s=$(date +%s) && NIX_CONFIG="max-jobs = 2" $out/bin/changed-checks --build --no-vm > $TMPDIR/cc-build.out 2> $TMPDIR/cc-build.err; r=$?; exit $r',
		);
		const [job] = jobsAsked();
		expect(job.needsGib).toBe(CHANGED_CHECKS_GIB);
	});

	it("asks for what sending takes for a changed-checks run that sends itself, whatever runs here held", async () => {
		const cc = "direnv exec . changed-checks > $TMPDIR/cc.log 2>&1";
		await ranBefore(
			{
				id: "here",
				kind: "build",
				what: cc,
			},
			0,
			0,
			{
				ownedPeakBytes: 13 * 1024 ** 3,
				ranS: 1_200,
			},
		);
		const asked: [string, string][] = [];
		queueingAfterRuns({
			sendsWholeRun: (command, cwd) => {
				asked.push([command, cwd]);
				return command.includes("cc.log");
			},
		});
		queuedCommand(cc, "/tree");
		queuedCommand(
			"direnv exec . changed-checks --here > $TMPDIR/here.log",
			"/tree",
		);
		const jobs = jobsAsked();
		const held = new Map(jobs.map((job) => [job.what, job.needsGib]));
		// The one sent is marked so, which spares it the CPU holds here.
		expect(new Map(jobs.map((job) => [job.what, job.sent]))).toEqual(
			new Map([
				[cc, true],
				["direnv exec . changed-checks --here > $TMPDIR/here.log", undefined],
			]),
		);
		expect(held).toEqual(
			new Map([
				[cc, CHANGED_CHECKS_SENT_GIB],
				[
					"direnv exec . changed-checks --here > $TMPDIR/here.log",
					CHANGED_CHECKS_GIB,
				],
			]),
		);
		expect(asked[0]).toEqual([cc, "/tree"]);
	});

	it("asks for what a sent changed-checks run was seen to hold, when that is less", async () => {
		// 10 November: changed-checks runs held 0.17 GiB at the median and
		// 0.37 at the 90th percentile, each booked 6 (80ECO2).
		const cc = "direnv exec . changed-checks > $TMPDIR/sent.log 2>&1";
		await ranBefore(
			{
				id: "sent-before",
				kind: "build",
				what: cc,
			},
			0,
			0,
			{
				ownedPeakBytes: 0.2 * 1024 ** 3,
				ranS: 300,
			},
		);
		queueingAfterRuns({
			sendsWholeRun: () => true,
		});
		queuedCommand(cc, "/tree");
		const [id] = jobIds();

		expect(
			JSON.parse(readFileSync(join(dir, `${id}.job`), "utf8")),
		).toMatchObject({ sent: true, needsGib: 1 });
	});

	it("asks for a turn, and runs at once when the room is there", async () => {
		mkdirSync(join(root, "timed"));
		writeFileSync(join(root, "timed", "cgroup.procs"), "");
		queueing(ROOMY);
		const command = queuedCommand("echo built $?; : cargo bench");
		const [id] = jobIds();
		expect(
			JSON.parse(readFileSync(join(dir, `${id}.job`), "utf8")),
		).toMatchObject({
			kind: "benchmark",
			cappable: true,
			owner: { session: "session-a", pid: process.pid },
		});
		const { out, code } = await run(command);
		expect({ out, code }).toEqual({ out: "built 0\n", code: 0 });
		const shell = Number(readFileSync(join(dir, `${id}.pid`), "utf8"));
		expect(readFileSync(join(root, "timed", "cgroup.procs"), "utf8")).toBe(
			`${shell}\n`,
		);
	});

	it("waits in its shell until its turn is given, and says so", async () => {
		const wait = waitsForTurn(dir, 1);
		writeFileSync(join(dir, "j1.job"), "{}\n");
		const started = Date.now();
		const ran = run(`${wait?.("j1")}\necho "ran $__job"`);
		// The turn is held back past the 1 s after which the wait is said.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		writeFileSync(join(dir, "j1.turn"), "");
		const { out } = await ran;
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
		expect(out).toMatch(
			/^Waited [1-9]\d*s for its turn in the machine queue\.\nran \n$/,
		);
	});

	it("marks the moment its turn begins, and not before", async () => {
		const wait = waitsForTurn(dir, 60);
		writeFileSync(join(dir, "j1.job"), "{}\n");
		const ran = run(`${wait?.("j1")}\ntrue`);
		// Proving no mark comes before the turn: nothing to wait on, so the
		// shell gets a span of its polls first.
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(readdirSync(dir)).not.toContain("j1.began");
		writeFileSync(join(dir, "j1.turn"), "");
		expect(await ran).toEqual({ out: "", code: 0 });
		expect(readdirSync(dir)).toContain("j1.began");
	});

	it("says the room left as work that ran long ends, keeping its code", async () => {
		writeFileSync(join(dir, "room"), "2 more VM tests and 8 more builds");
		const said = await run(`${waitsForTurn(dir, 5, 0)?.("gone")}\nexit 7`);
		expect(said).toEqual({
			out: "The machine has room for 2 more VM tests and 8 more builds right now. Builds and tests independent of each other can run at once, each as its own bash call with background: true, and each takes its own turn.\n",
			code: 7,
		});
		const quick = await run(`${waitsForTurn(dir, 5, 60)?.("gone")}\nexit 7`);
		expect(quick).toEqual({ out: "", code: 7 });
		expect(readFileSync(join(dir, "gone.end"), "utf8")).toBe("7\n");
		writeFileSync(join(dir, "room"), "");
		const full = await run(`${waitsForTurn(dir, 5, 0)?.("gone")}\ntrue`);
		expect(full).toEqual({ out: "", code: 0 });
	});

	it("caps the Nix builds of work given its turn beside a VM check", async () => {
		const wait = waitsForTurn(dir);
		for (const name of ["j3.job", "j3.turn", "j3.capped"]) {
			writeFileSync(join(dir, name), "");
		}
		writeFileSync(join(dir, "capped.conf"), "max-jobs = 1\ncores = 2\n");
		const show = 'echo "$NIX_USER_CONF_FILES"';
		const env = {
			...process.env,
			XDG_CONFIG_HOME: "/home/a/.config",
			XDG_CONFIG_DIRS: "/etc/xdg:/run/sw/etc/xdg",
			NIX_USER_CONF_FILES: "",
		};
		const capped = spawnSync("bash", ["-c", `${wait?.("j3")}\n${show}`], {
			env,
		});
		expect(capped.stdout.toString()).toBe(
			`${dir}/capped.conf:/home/a/.config/nix/nix.conf:/etc/xdg/nix/nix.conf:/run/sw/etc/xdg/nix/nix.conf\n`,
		);
		expect(capped.stderr.toString()).toBe(
			"Runs beside a VM check, so its Nix builds are held to 1 at once, of 2 cores each, and cargo to 2 jobs.\n",
		);
		const own = spawnSync("bash", ["-c", `${wait?.("j3")}\n${show}`], {
			env: { ...env, NIX_USER_CONF_FILES: "/mine.conf" },
		});
		expect(own.stdout.toString()).toBe(`${dir}/capped.conf:/mine.conf\n`);
		// A quick job's own settings, held tighter, come before capped.conf.
		writeFileSync(join(dir, "j3.capped"), "max-jobs = 1\ncores = 1\n");
		const quick = spawnSync("bash", ["-c", `${wait?.("j3")}\n${show}`], {
			env: { ...env, NIX_USER_CONF_FILES: "/mine.conf" },
		});
		expect(quick.stdout.toString()).toBe(`${dir}/j3.capped:/mine.conf\n`);
		expect(quick.stderr.toString()).toContain("of 1 cores each");
		rmSync(join(dir, "j3.capped"));
		const uncapped = spawnSync("bash", ["-c", `${wait?.("j3")}\n${show}`], {
			env,
		});
		expect(uncapped.stdout.toString()).toBe("\n");
	});

	it("caps cargo's jobs beside a VM check too, as it caps Nix's", async () => {
		// The cap reached only Nix, so a cargo build given its turn beside a
		// VM check still ran a rustc for every core.
		const wait = waitsForTurn(dir);
		for (const name of ["j4.job", "j4.turn", "j4.capped"]) {
			writeFileSync(join(dir, name), "");
		}
		writeFileSync(join(dir, "capped.conf"), "max-jobs = 2\ncores = 4\n");
		const show = 'echo "$CARGO_BUILD_JOBS"';
		const env = { ...process.env, CARGO_BUILD_JOBS: "16" };

		const capped = spawnSync("bash", ["-c", `${wait?.("j4")}\n${show}`], {
			env,
		});
		expect(capped.stdout.toString()).toBe("4\n");
		rmSync(join(dir, "j4.capped"));
		const uncapped = spawnSync("bash", ["-c", `${wait?.("j4")}\n${show}`], {
			env,
		});
		expect(uncapped.stdout.toString()).toBe("16\n");
	});

	it("gives way when its job is given up or nobody keeps the queue", () => {
		const wait = waitsForTurn(dir);
		const given = spawnSync("bash", ["-c", `${wait?.("gone")}\necho ran`], {
			timeout: 5_000,
		});
		expect(given.stdout.toString()).toBe("ran\n");
		writeFileSync(join(dir, "j2.job"), "{}\n");
		const old = Date.now() / 1000 - 121;
		utimesSync(join(dir, "queue.json"), old, old);
		const unkept = spawnSync("bash", ["-c", `${wait?.("j2")}\necho ran`], {
			timeout: 5_000,
		});
		expect(unkept.stdout.toString()).toBe("ran\n");
	});

	it("gives the keepers a grace after a sleep, and no longer", async () => {
		// The machine slept 153 s at 07:15 on 24 October. Nobody writes
		// queue.json while it sleeps, so on waking it reads as two minutes
		// unkept, and a waiting shell that looked before any keeper had
		// rewritten it would start its heavy work without a turn.
		const bin = join(root, "bin");
		mkdirSync(bin);
		const now = Math.floor(Date.now() / 1000);
		const counted = join(root, "calls");
		// The wall clock: now as the wait begins, then 200 s on, as it reads
		// after waking, and ticking from there.
		writeFileSync(
			join(bin, "date"),
			`#!${process.env.BASH ?? "/bin/sh"}\nn=$(cat '${counted}' 2>/dev/null || echo 0)\necho $((n + 1)) > '${counted}'\nif [ "$n" -eq 0 ]; then echo ${now}; else echo $((${now + 200} + n)); fi\n`,
			{ mode: 0o755 },
		);
		writeFileSync(join(dir, "j5.job"), "{}\n");
		const wait = waitsForTurn(dir);
		const shell = spawn("bash", ["-c", `${wait?.("j5")}\necho ran`], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		});
		let out = "";
		shell.stdout.on("data", (data: Buffer) => {
			out += data.toString();
		});
		const ended = new Promise<void>((resolve) =>
			shell.on("exit", () => resolve()),
		);
		try {
			// Proving the work waits out the grace: nothing to wait on, so a
			// span of the shell's polls goes by first.
			await new Promise((resolve) => setTimeout(resolve, 2_500));
			expect(out).toBe("");

			// No keeper woke to write queue.json, so once the grace is over
			// nobody keeps the queue and the work goes ahead.
			await ended;
			expect(out).toBe("ran\n");
		} finally {
			shell.kill();
		}
	}, 30_000);

	// 87KI6A [606d1d2c], 15 November: on macOS no wait waited, since a
	// Mac's stat reads a file's age with -f %m and refuses GNU's -c %Y.
	it("waits on a Mac, whose stat reads ages its own way", async () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "stat"),
			[
				`#!${process.env.BASH ?? "/bin/sh"}`,
				'if [ "$1 $2" = "-f %m" ]; then exec date -r "$3" +%s; fi',
				"echo 'stat: illegal option -- c' >&2; exit 1",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		writeFileSync(join(dir, "j6.job"), "{}\n");
		const shell = spawn(
			"bash",
			["-c", `${waitsForTurn(dir)?.("j6")}\necho ran`],
			{
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			},
		);
		let out = "";
		shell.stdout.on("data", (data: Buffer) => {
			out += data.toString();
		});
		const ended = new Promise<void>((resolve) =>
			shell.on("exit", () => resolve()),
		);
		try {
			// Proving it waits: nothing to wait on, so a span of polls goes by.
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			expect(out, "it went ahead without its turn").toBe("");
			writeFileSync(join(dir, "j6.turn"), "");
			await ended;
			expect(out).toBe("ran\n");
		} finally {
			shell.kill();
		}
	});

	it("can't quote a folder with a single quote in it", () => {
		expect(waitsForTurn("/run/it's")).toBeUndefined();
	});
});
