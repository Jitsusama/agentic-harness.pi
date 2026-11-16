/**
 * `pi-fence census` as a person or a gate runs it: node running the
 * script as it stands, over a /proc and a state folder of the test's
 * own, so its exit says whether every live session's commands are
 * fenced: 0 when none runs unfenced, 1 when one does or when the
 * machine's processes can't be read (fence-census.ts judges them).
 */

import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "pi-fence.ts");
const BOOT = "b0075eed-0000-4000-8000-000000000000";
const SESSION = "11111111-1111-4111-8111-111111111111";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-fence-census-"));
	mkdirSync(join(root, "proc/sys/kernel/random"), { recursive: true });
	writeFileSync(join(root, "proc/sys/kernel/random/boot_id"), `${BOOT}\n`);
	writeFileSync(join(root, "proc/uptime"), "500.00 9000.00\n");
	const presences = join(
		root,
		"state/pi/agentic-harness.pi/mesh-workflow/presence",
	);
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

/** Lay a process in the test's /proc, in the machine's mounts. */
function lay(pid: number, parent: number, name: string, env: string): void {
	const folder = join(root, "proc", String(pid));
	mkdirSync(join(folder, "ns"), { recursive: true });
	const rest = Array.from({ length: 20 }, (_, at) =>
		at === 0 ? String(parent) : at === 18 ? "1000" : "0",
	);
	writeFileSync(join(folder, "stat"), `${pid} (${name}) S ${rest.join(" ")}\n`);
	writeFileSync(join(folder, "status"), "NoNewPrivs:\t0\n");
	symlinkSync("mnt:[4026531841]", join(folder, "ns/mnt"));
	writeFileSync(join(folder, "environ"), env);
	writeFileSync(join(folder, "cmdline"), `${name}\0`);
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
	it("exits 0 when every live session is fenced or claims to be", async () => {
		lay(100, 1, "node", "PI_SANDBOX=fence\0");
		const ran = await census(join(root, "proc"));
		expect(ran.out).toBe(
			"1 live sessions: 0 proven fenced, 1 claimed, 0 unfenced\nclaimed  111111: no command running; its environment asks fence\n",
		);
		expect(ran.code).toBe(0);
	});

	it("exits 1, naming the session, when one runs a command unfenced", async () => {
		lay(100, 1, "node", "PI_SANDBOX=fence\0");
		lay(102, 100, "bash", "PI_BASH_KEEP=1\0");
		lay(103, 102, "sleep", "");
		const ran = await census(join(root, "proc"));
		expect(ran.out).toContain(
			"unfenced  111111: a command runs unfenced: sleep, pid 103",
		);
		expect(ran.code).toBe(1);
	});

	it("exits 1 when it can't read the machine's processes", async () => {
		const ran = await census(join(root, "nowhere"));
		expect(ran.out).toContain("can't read");
		expect(ran.code).toBe(1);
	});
});
