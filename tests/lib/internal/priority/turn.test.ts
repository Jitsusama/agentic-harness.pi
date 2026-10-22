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
			/^Waited [12]s for its turn in the machine queue\.\nran \n$/,
		);
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
