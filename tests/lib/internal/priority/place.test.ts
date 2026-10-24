import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	jobsProcs,
	placeChildren,
	placedCommand,
	shellMovesItself,
	withPi,
} from "../../../../lib/internal/priority/place.ts";

const OWN =
	"0::/user.slice/user-1000.slice/user@1000.service/app.slice/kitty-1-2.scope\n";

describe("jobsProcs", () => {
	it("puts the setting under the account's user manager", () => {
		expect(jobsProcs(OWN, "jobs.slice/jobs.service")).toBe(
			"/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/jobs.slice/jobs.service/cgroup.procs",
		);
	});

	it("is nowhere without a setting", () => {
		expect(jobsProcs(OWN, undefined)).toBeUndefined();
		expect(jobsProcs(OWN, " ")).toBeUndefined();
	});

	it("refuses a setting that would leave the account's own cgroups", () => {
		expect(jobsProcs(OWN, "/system.slice")).toBeUndefined();
		expect(jobsProcs(OWN, "../../system.slice")).toBeUndefined();
	});

	it("is nowhere outside a user manager", () => {
		expect(
			jobsProcs("0::/system.slice/x.service\n", "jobs.slice"),
		).toBeUndefined();
		expect(jobsProcs("", "jobs.slice")).toBeUndefined();
	});
});

/** Spawns `true` and resolves once it has exited. */
function spawned(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn("true");
		child.on("error", reject);
		child.on("exit", () => resolve(child.pid ?? -1));
	});
}

describe("placeChildren", () => {
	let undo: (() => void) | undefined;
	afterEach(() => {
		undo?.();
		undo = undefined;
	});

	it("writes each spawned child's pid into the jobs cgroup", async () => {
		const written: Array<[string, number]> = [];
		undo = placeChildren("/jobs/cgroup.procs", (path, pid) => {
			written.push([path, pid]);
		});
		const pid = await spawned();
		expect(written).toEqual([["/jobs/cgroup.procs", pid]]);
	});

	it("reaches a spawn made through execFile too", async () => {
		const written: number[] = [];
		undo = placeChildren("/jobs/cgroup.procs", (_path, pid) => {
			written.push(pid);
		});
		await new Promise<void>((resolve) => {
			const child = execFile("true", () => resolve());
			expect(child.pid).toBeDefined();
		});
		expect(written).toHaveLength(1);
	});

	it("wraps once however often it is placed, writing to the latest", async () => {
		const first: number[] = [];
		const second: number[] = [];
		placeChildren("/a", (_path, pid) => {
			first.push(pid);
		});
		undo = placeChildren("/b", (_path, pid) => {
			second.push(pid);
		});
		await spawned();
		expect(first).toEqual([]);
		expect(second).toHaveLength(1);
	});

	it("carries on past a child that left before it could move", async () => {
		let calls = 0;
		undo = placeChildren("/jobs", () => {
			calls += 1;
			throw Object.assign(new Error("gone"), { code: "ESRCH" });
		});
		await spawned();
		await spawned();
		expect(calls).toBe(2);
	});

	it("keeps placing after the cgroup was gone while it came back", async () => {
		const written: number[] = [];
		let gone = true;
		undo = placeChildren("/jobs", (_path, pid) => {
			if (gone) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			written.push(pid);
		});
		await spawned();
		gone = false;
		const pid = await spawned();
		expect(written).toEqual([pid]);
		expect(placedCommand("make")).not.toBe("make");
	});

	it("stops trying once the cgroup refuses, and the spawn still works", async () => {
		let calls = 0;
		undo = placeChildren("/jobs", () => {
			calls += 1;
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		});
		const pid = await spawned();
		await spawned();
		expect(pid).toBeGreaterThan(0);
		expect(calls).toBe(1);
	});

	it("has a shell move itself first while children are placed", () => {
		const dir = mkdtempSync(join(tmpdir(), "place-"));
		try {
			const procs = join(dir, "cgroup.procs");
			undo = placeChildren(procs, () => {});
			const said = execFileSync("bash", [
				"-c",
				placedCommand('echo "$? $$"'),
			]).toString();
			const [status, pid] = said.trim().split(" ");
			expect(status).toBe("0");
			expect(readFileSync(procs, "utf8")).toBe(`${pid}\n`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves a command as it is once the cgroup refuses", async () => {
		undo = placeChildren("/jobs", () => {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		});
		expect(placedCommand("make")).not.toBe("make");
		await spawned();
		expect(placedCommand("make")).toBe("make");
	});

	it("leaves a command as it is when nothing is placed", () => {
		expect(placedCommand("make")).toBe("make");
	});

	it("runs the command, silently, when the shell cannot move", () => {
		undo = placeChildren("/nonexistent/cgroup.procs", () => {});
		const run = spawnSync("bash", ["-c", placedCommand('echo "$?"')]);
		expect(run.stdout.toString()).toBe("0\n");
		expect(run.stderr.toString()).toBe("");
	});

	it("has no shell line for a path it can't quote", () => {
		expect(shellMovesItself("/a'b")).toBeUndefined();
	});

	it("leaves a helper pi keeps for itself where pi is", async () => {
		// The status line's git engine serves pi's own screen for as long as
		// pi runs. In jobs it starved behind the builds, and the footer lagged
		// whenever the machine was busy.
		const written: number[] = [];
		undo = placeChildren("/jobs", (_path, pid) => {
			written.push(pid);
		});
		const kept = await new Promise<number>((resolve, reject) => {
			const child = withPi(() => spawn("true"));
			child.on("error", reject);
			child.on("exit", () => resolve(child.pid ?? -1));
		});
		const placed = await spawned();

		expect(kept).toBeGreaterThan(0);
		expect(written).toEqual([placed]);
	});

	it("places again after a helper that failed to start", async () => {
		const written: number[] = [];
		undo = placeChildren("/jobs", (_path, pid) => {
			written.push(pid);
		});
		expect(() =>
			withPi(() => {
				throw new Error("no such program");
			}),
		).toThrow("no such program");
		const placed = await spawned();

		expect(written).toEqual([placed]);
	});

	it("leaves spawns alone once undone", async () => {
		const written: number[] = [];
		placeChildren("/jobs", (_path, pid) => {
			written.push(pid);
		})();
		await spawned();
		expect(written).toEqual([]);
	});
});
