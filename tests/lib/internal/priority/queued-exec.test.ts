import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Exec, spawnExec } from "../../../../lib/core/exec/index.ts";
import { queueFolder } from "../../../../lib/internal/priority/folder.ts";
import { queuedExec } from "../../../../lib/internal/priority/queued-exec.ts";
import { queueHeavyWork } from "../../../../lib/internal/priority/turn.ts";

let root: string;
let dir: string;
let undo: (() => void) | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "queued-exec-"));
	dir = join(root, "jobs");
	mkdirSync(dir);
	writeFileSync(join(dir, "queue.json"), "{}\n");
});
afterEach(() => {
	undo?.();
	undo = undefined;
	rmSync(root, { recursive: true, force: true });
});

function keepQueue(): void {
	undo = queueHeavyWork({
		folder: queueFolder(dir, {
			isRunning: () => true,
			cgroupOf: () => undefined,
		}),
		session: "session-a",
		pid: process.pid,
		room: () => ({
			availableGib: 40,
			memoryPressure: 0,
			vms: 0,
			cpuPressure: 0,
			cores: 16,
			pressure: { cpu: 0, memory: 0, io: 0 },
		}),
		cgroupFor: () => undefined,
	});
}

/** An exec that answers at once and remembers what it was asked. */
function recording(): { exec: Exec; asked: [string, string[]][] } {
	const asked: [string, string[]][] = [];
	return {
		asked,
		exec: async (command, args) => {
			asked.push([command, args]);
			return { code: 0, stdout: "", stderr: "" };
		},
	};
}

const jobs = () =>
	readdirSync(dir)
		.filter((name) => name.endsWith(".job"))
		.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));

const world = join(homedir(), "world", "trees", "w-main", "src");

describe("a tool's git put through the machine's queue", () => {
	it("runs light work, and all work with no queue kept, as it was", async () => {
		const direct = recording();
		const queued = recording();
		const exec = queuedExec(direct.exec, queued.exec);

		await exec("git", ["-C", world, "push", "origin", "x"]);
		keepQueue();
		await exec("git", ["-C", world, "rev-parse", "--verify", "refs/heads/x"]);

		expect(direct.asked).toEqual([
			["git", ["-C", world, "push", "origin", "x"]],
			["git", ["-C", world, "rev-parse", "--verify", "refs/heads/x"]],
		]);
		expect(queued.asked).toEqual([]);
		expect(jobs()).toEqual([]);
	});

	it("runs a push of World as the queue's shell, waiting its turn as a walk", async () => {
		keepQueue();
		const direct = recording();
		const queued = recording();
		const exec = queuedExec(direct.exec, queued.exec);

		await exec("git", ["-C", world, "push", "--set-upstream", "origin", "x"]);

		expect(direct.asked).toEqual([]);
		const [[command, args]] = queued.asked;
		expect(command).toBe("bash");
		expect(args[0]).toBe("-c");
		const shell = args[1] ?? "";
		const [job] = jobs();
		expect(job).toMatchObject({ kind: "world-walk", walk: "push" });
		expect(shell).toContain(`__job='${job.id}'`);
		expect(shell).toContain("core.hooksPath");
		expect(shell).toContain("--slice=");
		expect(shell).toContain(`git -C ${world} push --set-upstream origin x`);
	});

	it("answers with what git said once its turn comes", async () => {
		keepQueue();
		// The sandbox's runtime folder has no user bus, so the walk runs
		// outside the shared slice, as it does where there is no systemd.
		const exec = queuedExec(
			recording().exec,
			spawnExec({ timeoutMs: 60_000, env: { XDG_RUNTIME_DIR: "" } }),
		);
		const missing = join(homedir(), "world", "trees", "w-none-such", "src");

		const answer = exec("git", ["-C", missing, "push", "origin", "x"]);
		const [job] = jobs();
		writeFileSync(join(dir, `${job.id}.turn`), "");

		const result = await answer;
		expect(result.code).toBe(128);
		expect(result.stderr).toContain("w-none-such");
		expect(readFileSync(join(dir, `${job.id}.end`), "utf8").trim()).toBe("128");
	});

	it("hands the shell each word as it was given", async () => {
		keepQueue();
		const queued = recording();
		const exec = queuedExec(recording().exec, queued.exec);
		const odd = join(homedir(), "world", "trees", "it's", "src");

		await exec("git", ["-C", odd, "push", "origin", "x"]);

		const shell = queued.asked[0]?.[1][1] ?? "";
		const quoted = `'${odd.replace("'", `'\\''`)}'`;
		expect(shell).toContain(`git -C ${quoted} push origin x`);
	});
});
