/**
 * `pi-fence census` as a person or a gate runs it: node running the
 * script as it stands, over a /proc and a state folder of the test's
 * own, so its exit says whether every live session's commands are
 * fenced: 0 when each was seen fenced, 1 when one runs unfenced, when a
 * claimed one wasn't seen fenced in the last day, when there is no
 * session at all, or when the machine's processes can't be read
 * (fence-census.ts judges them). What it saw is kept between runs.
 *
 * And pi-fence as core runs it: straight from the harness's source, with
 * the store's node and no node_modules. Its run path loads there, and the
 * census, which needs packages, refuses with 126 saying so rather than
 * failing as an unfenced session would.
 */

import { execFile } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FENCE_RUN_HELP } from "../../lib/internal/fence-run.ts";
import { KEEPING_STUB } from "../../lib/internal/shell/kept.ts";

const HARNESS = join(import.meta.dirname, "..", "..");
const SCRIPT = join(HARNESS, "scripts", "pi-fence.ts");
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
 * rather than lifting it (fence-lifted.ts).
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
