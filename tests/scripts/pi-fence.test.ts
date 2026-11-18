/**
 * `pi-fence census` as a person or a gate runs it: node running the
 * script as it stands, over a /proc and a state folder of the test's
 * own, so its exit says whether every live session's commands are
 * fenced: 0 when each was seen fenced, 1 when one runs unfenced, when a
 * claimed one wasn't seen fenced in the last day, when there is no
 * session at all, or when the machine's processes can't be read
 * (fence/fence-census.ts judges them). What it saw is kept between runs.
 *
 * And pi-fence as core runs it: straight from the harness's source, with
 * the store's node and no node_modules. Its run path loads there, and the
 * census, which needs packages, refuses with 126 saying so rather than
 * failing as an unfenced session would.
 */

import { execFile, spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GRACE_MS } from "../../lib/internal/fence/fence-child.ts";
import { FENCE_RUN_HELP } from "../../lib/internal/fence/fence-run.ts";
import { KEEPING_STUB } from "../../lib/internal/shell/kept.ts";

const HARNESS = join(import.meta.dirname, "..", "..");
const SCRIPT = join(HARNESS, "scripts", "pi-fence.ts");
const STAND_IN = join(import.meta.dirname, "fixtures", "fence-child.mts");
const BOOT = "b0075eed-0000-4000-8000-000000000000";
const SESSION = "11111111-1111-4111-8111-111111111111";
const MACHINE = "mnt:[4026531841]";
const FENCED = "mnt:[4026532999]";

let root = "";
let presences = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-fence-census-"));
	mkdirSync(join(root, "proc/sys/kernel/random"), { recursive: true });
	writeFileSync(join(root, "proc/sys/kernel/random/boot_id"), `${BOOT}\n`);
	writeFileSync(join(root, "proc/uptime"), "500.00 9000.00\n");
	presences = join(root, "state/pi/agentic-harness.pi/mesh-workflow/presence");
	mkdirSync(presences, { recursive: true });
	writeFileSync(
		join(presences, `${SESSION}.json`),
		JSON.stringify({
			session: SESSION,
			addresses: ["111111"],
			groups: [],
			worksOn: "",
			owns: [],
			busy: false,
			at: "2026-11-16T09:00:00Z",
			fence: "fence",
			owner: { pid: 100, startedAt: 0, bootId: BOOT, startTicks: 1000 },
		}),
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** How a process is laid beyond its name and parent. */
interface Laid {
	readonly env?: string;
	readonly argv?: readonly string[];
	readonly exe?: string;
	readonly fenced?: boolean;
}

/** Lay a process in the test's /proc, in the machine's mounts unless fenced. */
function lay(pid: number, parent: number, name: string, laid: Laid = {}): void {
	const folder = join(root, "proc", String(pid));
	mkdirSync(join(folder, "ns"), { recursive: true });
	const rest = Array.from({ length: 20 }, (_, at) =>
		at === 0 ? String(parent) : at === 18 ? "1000" : "0",
	);
	writeFileSync(join(folder, "stat"), `${pid} (${name}) S ${rest.join(" ")}\n`);
	writeFileSync(
		join(folder, "status"),
		`NoNewPrivs:\t${laid.fenced ? 1 : 0}\n`,
	);
	symlinkSync(laid.fenced ? FENCED : MACHINE, join(folder, "ns/mnt"));
	if (laid.exe !== undefined) symlinkSync(laid.exe, join(folder, "exe"));
	// A fenced process's root, where nothing the fence hides is to be seen.
	if (laid.fenced) mkdirSync(join(folder, "root"));
	writeFileSync(join(folder, "environ"), laid.env ?? "");
	writeFileSync(
		join(folder, "cmdline"),
		(laid.argv ?? [name]).map((word) => `${word}\0`).join(""),
	);
}

/**
 * A subagent's environment, the one pi that keeps `PI_SANDBOX=fence`
 * rather than lifting it (fence/fence-lifted.ts).
 */
const SUBAGENT_FENCED = "PI_SANDBOX=fence\0SUBAGENT_RUN_ID=run-1\0";

/** A pi asking for the fence, and one fenced call under it. */
function fencedCall(): void {
	const keep = join(root, "state/pi/agentic-harness.pi/shell-workflow/kept/a");
	lay(100, 1, "node", { env: SUBAGENT_FENCED });
	lay(102, 100, "bash", {
		env: `PI_BASH_KEEP=${keep}\0`,
		argv: ["bash", "-c", KEEPING_STUB],
		exe: "/nix/store/0000-bash-5.3/bin/bash",
	});
	lay(103, 102, "sleep", { fenced: true });
}

/** The census, run as pi-fence over the test's machine. */
function census(
	proc: string,
): Promise<{ readonly code: number; readonly out: string }> {
	return new Promise((done) => {
		execFile(
			process.execPath,
			[
				"--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
				SCRIPT,
				"census",
				"--proc",
				proc,
			],
			{
				env: {
					PATH: process.env.PATH,
					HOME: root,
					XDG_STATE_HOME: join(root, "state"),
				},
			},
			(error, stdout, stderr) => {
				const code = error ? Number(error.code ?? 1) : 0;
				done({ code, out: `${stdout}${stderr}` });
			},
		);
	});
}

describe("pi-fence census", () => {
	it("exits 1 for a session that claims the fence but was never seen fenced", async () => {
		lay(100, 1, "node", { env: SUBAGENT_FENCED });
		const ran = await census(join(root, "proc"));
		expect(ran.out).toBe(
			"1 live session: 0 proven fenced, 1 claimed, 0 unfenced\n" +
				"claimed  111111: no command running; its environment asks fence; " +
				"not seen fenced in the last 24 hours\n",
		);
		expect(ran.code).toBe(1);
	});

	it("exits 0 once a census saw the session's command fenced, and on through the day", async () => {
		fencedCall();
		const seen = await census(join(root, "proc"));
		expect(seen.out).toBe(
			"1 live session: 1 proven fenced, 0 claimed, 0 unfenced\n",
		);
		expect(seen.code).toBe(0);
		rmSync(join(root, "proc/102"), { recursive: true });
		rmSync(join(root, "proc/103"), { recursive: true });
		const idle = await census(join(root, "proc"));
		expect(idle.out).toContain("seen fenced within the hour");
		expect(idle.code).toBe(0);
	});

	it("exits 1, naming the session, when one runs a command unfenced", async () => {
		lay(100, 1, "node", { env: "PI_SANDBOX=fence\0" });
		lay(102, 100, "bash", { env: "PI_BASH_KEEP=1\0" });
		lay(103, 102, "sleep");
		const ran = await census(join(root, "proc"));
		expect(ran.out).toContain(
			"unfenced  111111: a command runs unfenced: sleep, pid 103",
		);
		expect(ran.code).toBe(1);
	});

	it("exits 1 when it finds no live session", async () => {
		rmSync(presences, { recursive: true });
		const ran = await census(join(root, "proc"));
		expect(ran.out).toBe(
			"0 live sessions: 0 proven fenced, 0 claimed, 0 unfenced\n",
		);
		expect(ran.code).toBe(1);
	});

	it("exits 1 when it can't read the machine's processes", async () => {
		const ran = await census(join(root, "nowhere"));
		expect(ran.out).toContain("can't read");
		expect(ran.code).toBe(1);
	});
});

/** pi-fence run from `harness` with `args`, as core's store build runs it. */
function bare(
	harness: string,
	args: readonly string[],
): Promise<{
	readonly code: number;
	readonly out: string;
	readonly err: string;
}> {
	return new Promise((done) => {
		execFile(
			process.execPath,
			[
				"--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
				join(harness, "scripts", "pi-fence.ts"),
				...args,
			],
			{ env: { PATH: process.env.PATH, HOME: root }, cwd: root },
			(error, stdout, stderr) => {
				const code = error ? Number(error.code ?? 1) : 0;
				done({ code, out: String(stdout), err: String(stderr) });
			},
		);
	});
}

describe("pi-fence with no packages", () => {
	let harness = "";
	beforeEach(() => {
		// The source as core's store build has it: no node_modules beside it.
		harness = join(root, "harness");
		for (const part of ["scripts", "lib", "data"]) {
			cpSync(join(HARNESS, part), join(harness, part), { recursive: true });
		}
	});

	it("loads its run path, saying how to ask it", async () => {
		const ran = await bare(harness, ["--help"]);
		expect(ran.err, "nothing on stderr").toBe("");
		expect(ran.code, ran.err).toBe(0);
		expect(ran.out).toBe(FENCE_RUN_HELP);
	});

	it("builds a fenced run as far as its refusal of a folder holding the home", async () => {
		const ran = await bare(harness, [
			"--kind",
			"fence",
			"--folder",
			"/",
			"--",
			"true",
		]);
		expect(ran.code, ran.err).toBe(126);
		expect(ran.err).toMatch(
			/^pi-fence: pi-fence --kind fence won't let commands write \/,/u,
		);
	});

	it("refuses a census it can't load, with 126 and why, not as an unfenced session", async () => {
		const ran = await bare(harness, ["census"]);
		expect(ran.code, ran.err).toBe(126);
		expect(ran.err).toMatch(/^pi-fence: the census couldn't load: .*yaml/u);
	});
});

/** How pi-fence's child ended: its status, or the signal it died by. */
interface Ended {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

/**
 * pi-fence's child, run as pi-fence runs it, with no terminal; in a
 * process group of its own when `grouped`, as pi's bash tool runs it,
 * and with `path` for PATH.
 */
function child(
	text: string,
	{ grouped = false, path = process.env.PATH } = {},
): {
	readonly pid: number;
	readonly ended: Promise<Ended>;
	readonly err: () => string;
} {
	const ran = spawn(
		process.execPath,
		["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", STAND_IN, text],
		{
			cwd: root,
			env: { PATH: path, HOME: root },
			stdio: ["ignore", "pipe", "pipe"],
			detached: grouped,
		},
	);
	let err = "";
	ran.stderr.on("data", (chunk) => {
		err += String(chunk);
	});
	const ended = new Promise<Ended>((done) =>
		ran.on("exit", (code, signal) => done({ code, signal })),
	);
	// A signal to pid 0 would reach the test's own process group.
	if (ran.pid === undefined) throw new Error("the stand-in didn't start");
	return { pid: ran.pid, ended, err: () => err };
}

/** Whether process `pid` is still there. */
function there(pid: number): boolean {
	if (pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// ESRCH: gone.
		return false;
	}
}

/** Whether process group `group` still has a process in it. */
function groupThere(group: number): boolean {
	if (group <= 1) return false;
	try {
		process.kill(-group, 0);
		return true;
	} catch {
		// ESRCH: nothing is left in it.
		return false;
	}
}

/** Waits up to `ms` for `ready`, checking every 50 ms. */
async function waitFor(ready: () => boolean, ms: number): Promise<boolean> {
	for (const until = Date.now() + ms; Date.now() < until; ) {
		if (ready()) return true;
		// Polling a process from outside it: nothing to wait on but time.
		await new Promise((next) => setTimeout(next, 50));
	}
	return ready();
}

/** The longest a case here may take: a grace, and room for a loaded machine. */
const CASE_MS = 30_000;

describe("pi-fence's child", () => {
	const left: number[] = [];
	afterEach(() => {
		for (const pid of left.splice(0)) {
			if (pid > 1 && there(pid)) process.kill(pid, "SIGKILL");
		}
	});

	/** Runs `sleep 300` in the background of `before`, and the sleeper's pid once it runs. */
	async function sleeping(before = "", how = {}) {
		const pidFile = join(root, "sleeper.pid");
		const ran = child(`${before}sleep 300 & echo $! > '${pidFile}'; wait`, how);
		left.push(ran.pid);
		// Read once written whole: an empty file reads as pid 0, and a
		// signal to 0 is a signal to the test's own process group.
		const sleeperPid = () =>
			existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
		const started = await waitFor(() => sleeperPid() > 1, 10_000);
		expect(started, "the command started its sleeper").toBe(true);
		const sleeper = sleeperPid();
		left.push(sleeper);
		return { ran, sleeper };
	}

	it("ends with the command's own status", async () => {
		expect(await child("exit 7").ended).toEqual({ code: 7, signal: null });
	});

	it(
		"ends its whole group once the command ends, its watcher too",
		async () => {
			const groupFile = join(root, "group.pid");
			const ran = child(`sleep 300 & echo $$ > '${groupFile}'`);
			left.push(ran.pid);

			expect(await ran.ended).toEqual({ code: 0, signal: null });
			// The shell's pid is its group's, in a session of its own.
			const group = Number(readFileSync(groupFile, "utf8").trim());
			const gone = await waitFor(() => group > 1 && !groupThere(group), 5000);
			expect(gone, `the group ${group} ended with pi-fence`).toBe(true);
		},
		CASE_MS,
	);

	// On a Mac the shell execs into sandbox-exec and the command, which
	// would inherit as a child a watcher it never started.
	it(
		"never leaves its watcher for the command to wait on",
		async () => {
			const ran = child("exec perl -e '1 while wait() != -1'");
			left.push(ran.pid);
			expect(await ran.ended).toEqual({ code: 0, signal: null });
		},
		CASE_MS,
	);

	it("says a shell's own signal as a shell does", async () => {
		expect(await child("kill -TERM $$").ended).toEqual({
			code: 128 + 15,
			signal: null,
		});
	});

	it("keeps its watcher's pipe from the command", async () => {
		const ran = child("if [ -e /dev/fd/3 ]; then exit 9; fi");
		expect(await ran.ended).toEqual({ code: 0, signal: null });
	});

	it(
		"passes the signal to the command, which may end its own way",
		async () => {
			const heard = join(root, "heard");
			const { ran } = await sleeping(
				`trap "echo TERM > '${heard}'; exit 3" TERM; `,
			);

			process.kill(ran.pid, "SIGTERM");

			expect(await ran.ended).toEqual({ code: 3, signal: null });
			expect(readFileSync(heard, "utf8")).toBe("TERM\n");
		},
		CASE_MS,
	);

	// The watcher is in the group the signal goes to, so it must outlive it.
	it(
		"ends background work that ignores the signal its shell ended by",
		async () => {
			const pidFile = join(root, "deaf.pid");
			// Written once its trap is set, so the signal can't come first.
			const { ran } = await sleeping(
				`( trap '' TERM; exec bash -c "echo \\$\\$ > '${pidFile}'; exec sleep 301" ) & `,
			);
			const deafPid = () =>
				existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
			const started = await waitFor(() => deafPid() > 1, 10_000);
			expect(started, "the deaf sleeper wrote its pid").toBe(true);
			const deaf = deafPid();
			left.push(deaf);

			process.kill(ran.pid, "SIGTERM");

			expect(await ran.ended).toEqual({ code: null, signal: "SIGTERM" });
			const gone = await waitFor(() => !there(deaf), 5000);
			expect(gone, `the deaf sleeper ${deaf} ended with pi-fence`).toBe(true);
		},
		CASE_MS,
	);

	it("says bash didn't start, with 126", async () => {
		const ran = child("true", { path: root });
		expect(await ran.ended).toEqual({ code: 126, signal: null });
		expect(ran.err()).toMatch(/^pi-fence: bash didn't start: /u);
	});

	// On 17 November a timed-out run on the Mac left its sandboxed command
	// running: the signal ended pi-fence alone (ISXEG8, slice 2).
	it.each(["SIGTERM", "SIGHUP", "SIGALRM", "SIGINT"] as const)(
		"ends what its command started when told %s, and dies by it",
		async (signal) => {
			const { ran, sleeper } = await sleeping();

			const told = Date.now();
			process.kill(ran.pid, signal);

			expect(await ran.ended).toEqual({ code: null, signal });
			// Ended by the signal itself, not the grace's SIGKILL.
			expect(Date.now() - told).toBeLessThan(GRACE_MS);
			const gone = await waitFor(() => !there(sleeper), 5000);
			expect(gone, `the sleeper ${sleeper} ended with pi-fence`).toBe(true);
		},
		CASE_MS,
	);

	// A shell running a script stops it on Ctrl-C only when the command
	// it waited on died by SIGINT, rather than exiting 130.
	it.skipIf(process.platform !== "linux")(
		"stops a calling script on a terminal's Ctrl-C",
		async () => {
			const run = `${process.execPath} --disable-warning=MODULE_TYPELESS_PACKAGE_JSON ${STAND_IN} "echo up; exec sleep 30"`;
			const ran = spawn(
				"script",
				["-qec", `bash -c '${run}; echo after'`, "/dev/null"],
				{
					cwd: root,
					env: { PATH: process.env.PATH, HOME: root },
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			if (ran.pid === undefined) throw new Error("script didn't start");
			left.push(ran.pid);
			let said = "";
			ran.stdout.on("data", (chunk) => {
				said += String(chunk);
			});
			const ended = new Promise((done) => ran.on("exit", done));
			const up = await waitFor(() => said.includes("up"), 20_000);
			expect(up, `the run started: ${said}`).toBe(true);

			ran.stdin.write("\u0003");
			await ended;

			expect(said).not.toContain("after");
		},
		CASE_MS,
	);

	// pi's bash tool ends a command with SIGKILL to its process group,
	// which no handler hears, and a Mac's sandbox doesn't die with its parent.
	it(
		"ends what its command started once killed outright",
		async () => {
			const { ran, sleeper } = await sleeping();

			process.kill(ran.pid, "SIGKILL");

			expect(await ran.ended).toEqual({ code: null, signal: "SIGKILL" });
			const gone = await waitFor(() => !there(sleeper), 5000);
			expect(gone, `the sleeper ${sleeper} ended with pi-fence`).toBe(true);
		},
		CASE_MS,
	);

	it(
		"ends what its command started once its whole process group is killed",
		async () => {
			const { ran, sleeper } = await sleeping("", { grouped: true });

			process.kill(-ran.pid, "SIGKILL");

			const gone = await waitFor(() => !there(sleeper), 5000);
			expect(gone, `the sleeper ${sleeper} ended with pi-fence`).toBe(true);
		},
		CASE_MS,
	);

	it(
		"kills a command that ignores the signal it was told, after a grace",
		async () => {
			const { ran, sleeper } = await sleeping("trap '' TERM; ");

			const told = Date.now();
			process.kill(ran.pid, "SIGTERM");

			expect(await ran.ended).toEqual({ code: null, signal: "SIGTERM" });
			expect(Date.now() - told).toBeGreaterThanOrEqual(GRACE_MS - 100);
			const gone = await waitFor(() => !there(sleeper), 5000);
			expect(gone, `the sleeper ${sleeper} ended with pi-fence`).toBe(true);
		},
		CASE_MS,
	);
});
