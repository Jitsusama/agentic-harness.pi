import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	diskRemovalCalls,
	ensureQuestWorkspaceTmp,
	processesIn,
	questWorkspace,
	removeQuestWorkspace,
	removeTree,
	type TreeRemovalCalls,
} from "../../../../lib/core/internal/quest/workspace.ts";
import { rosterDir } from "../../../../lib/core/session/roster.ts";

const QUEST_ID = "QEST-20260924-ABC123";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "workspace-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("questWorkspace", () => {
	it("names the workspace after the quest, with tmp/ inside it", () => {
		expect(questWorkspace(root, QUEST_ID)).toEqual({
			dir: join(root, QUEST_ID),
			tmp: join(root, QUEST_ID, "tmp"),
		});
	});

	it("refuses anything that is not a quest's ID", () => {
		for (const id of [
			"../etc",
			"PLAN-20260924-ABC123",
			"",
			"QEST-20260924-ABC123/..",
		]) {
			expect(() => questWorkspace(root, id), id).toThrow(/not a quest ID/);
		}
	});
});

describe("ensureQuestWorkspaceTmp", () => {
	it("creates tmp/ on first need and reuses it after", () => {
		const tmp = ensureQuestWorkspaceTmp(root, QUEST_ID);
		expect(tmp).toBe(join(root, QUEST_ID, "tmp"));
		expect(existsSync(tmp), `${tmp} exists`).toBe(true);
		writeFileSync(join(tmp, "kept.txt"), "x");
		expect(ensureQuestWorkspaceTmp(root, QUEST_ID)).toBe(tmp);
		expect(readdirSync(tmp)).toEqual(["kept.txt"]);
	});
});

describe("removeQuestWorkspace", () => {
	const nobody = () => [];

	it("takes the whole workspace, its caches and labs with its tmp/", async () => {
		const { dir, tmp } = questWorkspace(root, QUEST_ID);
		mkdirSync(join(tmp, "deep"), { recursive: true });
		writeFileSync(join(tmp, "deep", "scratch.txt"), "x");
		mkdirSync(join(dir, "lab"));
		writeFileSync(join(dir, "lab", "results.csv"), "x");

		expect(await removeQuestWorkspace(root, QUEST_ID, nobody)).toEqual({
			removed: true,
		});
		expect(existsSync(dir), `${dir} is removed`).toBe(false);
	});

	it("gives the thread back while it removes, so a host's other conversations run", async () => {
		const { dir } = questWorkspace(root, QUEST_ID);
		for (let folder = 0; folder < 20; folder++) {
			const cache = join(dir, "cache", `f${folder}`);
			mkdirSync(cache, { recursive: true });
			for (let file = 0; file < 20; file++) {
				writeFileSync(join(cache, `${file}.o`), "x");
			}
		}
		let turns = 0;
		let removing = true;
		const turn = () => {
			if (!removing) return;
			turns += 1;
			setImmediate(turn);
		};
		setImmediate(turn);

		const removal = await removeQuestWorkspace(
			root,
			QUEST_ID,
			nobody,
		).finally(() => {
			removing = false;
		});

		expect(removal).toEqual({ removed: true });
		expect(existsSync(dir), `${dir} is removed`).toBe(false);
		expect(turns, "turns the loop took while it removed").toBeGreaterThan(0);
	});

	it("takes a folder made read-only, as Go's module cache is", async () => {
		const { dir } = questWorkspace(root, QUEST_ID);
		const module = join(dir, "cache", "go-mod", "example.com@v1.0.0");
		mkdirSync(module, { recursive: true });
		writeFileSync(join(module, "go.mod"), "module example.com\n");
		chmodSync(module, 0o555);

		expect(await removeQuestWorkspace(root, QUEST_ID, nobody)).toMatchObject({
			removed: true,
		});
		expect(existsSync(dir), `${dir} is removed`).toBe(false);
	});

	it("leaves a workspace a process still works in", async () => {
		const { dir } = questWorkspace(root, QUEST_ID);
		mkdirSync(dir, { recursive: true });

		expect(await removeQuestWorkspace(root, QUEST_ID, () => [42])).toEqual({
			removed: false,
			why: "in use",
		});
		expect(existsSync(dir), `${dir} is kept`).toBe(true);
	});

	it("leaves a workspace a hosted conversation works in, by its roster", async () => {
		const { dir } = questWorkspace(root, QUEST_ID);
		const clone = join(dir, "clone");
		mkdirSync(clone, { recursive: true });
		const rosters = rosterDir();
		mkdirSync(rosters, { recursive: true });
		const roster = join(rosters, "test-background.json");
		writeFileSync(
			roster,
			JSON.stringify({
				v: 1,
				key: "test-background",
				sessions: [
					{
						sessionId: "019e0c11-2b2c-7bd5-9e04-1c3c0a5b7a10",
						file: join(root, "session.jsonl"),
						cwd: clone,
						attended: false,
						since: "2026-11-11T02:00:00.000Z",
					},
				],
			}),
		);
		try {
			// No process works in it, so only the roster keeps it.
			expect(await removeQuestWorkspace(root, QUEST_ID)).toEqual({
				removed: false,
				why: "in use",
			});
			expect(existsSync(clone), `${clone} is kept`).toBe(true);
		} finally {
			rmSync(roster, { force: true });
		}
		expect(await removeQuestWorkspace(root, QUEST_ID)).toEqual({
			removed: true,
		});
	});

	it("says there was none to take", async () => {
		expect(await removeQuestWorkspace(root, QUEST_ID, nobody)).toEqual({
			removed: false,
			why: "none",
		});
	});

	it("removes a link in it, never what the link points to", async () => {
		const { dir } = questWorkspace(root, QUEST_ID);
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "kept.txt"), "x");
		mkdirSync(dir);
		symlinkSync(outside, join(dir, "link"));

		expect(await removeQuestWorkspace(root, QUEST_ID, nobody)).toEqual({
			removed: true,
		});
		expect(existsSync(dir), `${dir} is removed`).toBe(false);
		expect(readdirSync(outside), "what it pointed to").toEqual(["kept.txt"]);
	});
});

describe("removeTree", () => {
	/** The filesystem's calls, counting how many are in flight at once. */
	function counted(): { calls: TreeRemovalCalls; most: () => number } {
		let now = 0;
		let most = 0;
		async function count<R>(call: Promise<R>): Promise<R> {
			now += 1;
			most = Math.max(most, now);
			try {
				return await call;
			} finally {
				now -= 1;
			}
		}
		const disk = diskRemovalCalls;
		const calls: TreeRemovalCalls = {
			lstat: (path) => count(disk.lstat(path)),
			chmod: (path, mode) => count(disk.chmod(path, mode)),
			entries: (dir) => count(disk.entries(dir)),
			rmdir: (path) => count(disk.rmdir(path)),
			unlink: (path) => count(disk.unlink(path)),
		};
		return { calls, most: () => most };
	}

	it("makes one filesystem call at a time, leaving the thread pool to others", async () => {
		const dir = join(root, "tree");
		for (let folder = 0; folder < 5; folder++) {
			const cache = join(dir, `f${folder}`);
			mkdirSync(cache, { recursive: true });
			for (let file = 0; file < 5; file++) {
				writeFileSync(join(cache, `${file}.o`), "x");
			}
		}
		const { calls, most } = counted();

		await removeTree(dir, calls);

		expect(existsSync(dir), `${dir} is removed`).toBe(false);
		expect(most(), "calls in flight at once").toBe(1);
	});

	it("counts what something else removed meanwhile as gone", async () => {
		const dir = join(root, "tree");
		mkdirSync(dir);
		writeFileSync(join(dir, "raced.txt"), "x");
		const racing: TreeRemovalCalls = {
			...diskRemovalCalls,
			unlink: async (path) => {
				await diskRemovalCalls.unlink(path);
				return diskRemovalCalls.unlink(path);
			},
		};

		await removeTree(dir, racing);

		expect(existsSync(dir), `${dir} is removed`).toBe(false);
	});

	it("gives up on any other failure, saying what it was", async () => {
		const dir = join(root, "tree");
		mkdirSync(dir);
		writeFileSync(join(dir, "held.txt"), "x");
		const refused = Object.assign(new Error("EBUSY: held"), { code: "EBUSY" });
		const refusing: TreeRemovalCalls = {
			...diskRemovalCalls,
			unlink: () => Promise.reject(refused),
		};

		await expect(removeTree(dir, refusing)).rejects.toBe(refused);
		expect(existsSync(join(dir, "held.txt")), "what it couldn't take").toBe(
			true,
		);
	});
});

describe.runIf(process.platform === "linux")("processesIn", () => {
	it("finds a process working in a folder, and none once it ends", async () => {
		const { dir } = questWorkspace(root, QUEST_ID);
		mkdirSync(dir, { recursive: true });
		const child = spawn("sleep", ["30"], { cwd: dir, stdio: "ignore" });
		await new Promise((resolve) => child.once("spawn", resolve));
		try {
			expect(processesIn(dir)).toContain(child.pid);
		} finally {
			child.kill();
		}
		await new Promise((resolve) => child.once("exit", resolve));
		expect(processesIn(dir)).not.toContain(child.pid);
	});
});
