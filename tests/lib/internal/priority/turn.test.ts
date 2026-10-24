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
			"Runs beside a VM check, so its Nix builds are held to 1 at once, of 2 cores each.\n",
		);
		const own = spawnSync("bash", ["-c", `${wait?.("j3")}\n${show}`], {
			env: { ...env, NIX_USER_CONF_FILES: "/mine.conf" },
		});
		expect(own.stdout.toString()).toBe(`${dir}/capped.conf:/mine.conf\n`);
		rmSync(join(dir, "j3.capped"));
		const uncapped = spawnSync("bash", ["-c", `${wait?.("j3")}\n${show}`], {
			env,
		});
		expect(uncapped.stdout.toString()).toBe("\n");
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

	it("can't quote a folder with a single quote in it", () => {
		expect(waitsForTurn("/run/it's")).toBeUndefined();
	});
});
