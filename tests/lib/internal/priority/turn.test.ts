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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queueFolder } from "../../../../lib/internal/priority/folder.ts";
import {
	keepOutcome,
	outcomeOf,
} from "../../../../lib/internal/priority/outcome.ts";
import {
	CHANGED_CHECKS_GIB,
	EVERY_CHECK_GIB,
} from "../../../../lib/internal/priority/queue.ts";
import type { Reading } from "../../../../lib/internal/priority/room.ts";
import {
	queuedCommand,
	queueHeavyWork,
	waitsForTurn,
} from "../../../../lib/internal/priority/turn.ts";

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
		pid: process.pid,
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

describe("heavy work waiting for its turn", () => {
	it("leaves light work, and all work with no queue kept, as it was", () => {
		expect(queuedCommand("cargo build")).toBe("cargo build");
		queueing(ROOMY);
		expect(queuedCommand("git status")).toBe("git status");
		expect(jobIds()).toEqual([]);
	});

	it("asks as a VM check for work whose builds last ran one", () => {
		const outcomes = join(root, "outcomes.jsonl");
		const ran = new Date().toISOString();
		keepOutcome(outcomes, {
			...outcomeOf(
				{
					id: "before",
					kind: "build",
					what: "nix flake check --keep-going",
					owner: { session: "session-a", pid: 1 },
					since: ran,
					started: ran,
					ranTimed: true,
				},
				Date.now(),
				0,
			),
		});
		undo = queueHeavyWork({
			folder: queueFolder(
				dir,
				{ isRunning: () => true, cgroupOf: () => undefined },
				undefined,
				outcomes,
			),
			session: "session-a",
			pid: process.pid,
			room: () => ROOMY,
			cgroupFor: () => undefined,
		});
		queuedCommand("nix flake check --keep-going");
		queuedCommand("nix build .#tool");
		const kinds = jobIds()
			.map((id) => JSON.parse(readFileSync(join(dir, `${id}.job`), "utf8")))
			.map((job) => [job.what, job.kind])
			.sort();
		expect(kinds).toEqual([
			["nix build .#tool", "build"],
			["nix flake check --keep-going", "vm-check"],
		]);
	});

	it("asks for the memory its whole step needs, past where its name is cut", () => {
		// On 24 October an evaluation of every check on a commit's flake
		// was held to a build's 4 GiB, its `#checks` past the cut.
		queueing(ROOMY);
		const rev = "fbbe51d2220badda56d82cfc6b681cd0213876c8";
		queuedCommand(
			`nix eval --json "git+file:///home/jitsusama/.local/state/pi/agentic-harness.pi/work/trees/worktree-github-Jitsusama-core.nix-main?rev=${rev}#checks.x86_64-linux" --apply builtins.attrNames > names.json`,
		);
		const [id] = jobIds();
		const job = JSON.parse(readFileSync(join(dir, `${id}.job`), "utf8"));
		expect(job.what).not.toContain("#checks");
		expect(job.needsGib).toBe(EVERY_CHECK_GIB);
	});

	it("asks for the memory of its heaviest step, not its first", () => {
		// Y9XISP's on 24 October: the tool's build came first, so the job
		// was held to a build's 4 GiB while the tool it built used 11.8.
		queueing(ROOMY);
		queuedCommand(
			'cd $T && rev=$(git rev-parse HEAD); out=$(nix build --no-link --print-out-paths "git+file://$PWD?rev=$rev#checks.x86_64-linux.changed-checks-names-what-moved") && s=$(date +%s) && NIX_CONFIG="max-jobs = 2" $out/bin/changed-checks --build --no-vm > $TMPDIR/cc-build.out 2> $TMPDIR/cc-build.err; r=$?; exit $r',
		);
		const [id] = jobIds();
		const job = JSON.parse(readFileSync(join(dir, `${id}.job`), "utf8"));
		expect(job.needsGib).toBe(CHANGED_CHECKS_GIB);
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

	it("can't quote a folder with a single quote in it", () => {
		expect(waitsForTurn("/run/it's")).toBeUndefined();
	});
});
