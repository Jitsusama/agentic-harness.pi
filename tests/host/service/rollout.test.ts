/** The rollout gate: a second conversation waits until every live pi tells hosted conversations apart. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CENSUS_COMMIT,
	hostRolloutGate,
	loadedFolderOf,
	type RolloutFacts,
	refusalText,
	rolloutFacts,
	rolloutGate,
	staleHarnesses,
} from "../../../host/service/rollout.ts";

const SELF = 100;
const NEW = "/install/versions/new";
const OLD = "/install/versions/old";

let dir: string;
let loaded: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "k7-rollout-"));
	loaded = join(dir, "loaded");
	await mkdir(loaded);
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function says(pid: number | string, body: unknown): Promise<void> {
	await writeFile(
		join(loaded, String(pid)),
		typeof body === "string" ? body : `${JSON.stringify(body)}\n`,
	);
}

/**
 * Facts over a fixed set of live pids and roots' verdicts, counting git's
 * asks. A pid's process started at the time `starts` gives, or at none.
 */
function facts(
	live: readonly number[],
	verdicts: Record<string, boolean | undefined>,
	starts: Record<number, number> = {},
): RolloutFacts & { holds: ReturnType<typeof vi.fn> } {
	return {
		alive: (pid) => live.includes(pid),
		startedAt: async (pid) => starts[pid],
		holds: vi.fn(async (root: string) => verdicts[root]),
	};
}

describe("staleHarnesses", () => {
	it("leaves out a file whose pid a process started after it wears, past the boot clock's drift", async () => {
		const written = new Date("2026-11-09T12:00:00Z");
		for (const pid of [8, 9, 10]) {
			await says(pid, { root: OLD });
			await utimes(join(loaded, String(pid)), written, written);
		}
		const at = written.getTime();
		const machine = facts(
			[8, 9, 10],
			{ [OLD]: false },
			{
				8: at + 120_000,
				9: at + 10_000,
			},
		);

		expect(
			(await staleHarnesses({ loadedDir: loaded, facts: machine })).map(
				({ pid }) => pid,
			),
		).toEqual([9, 10]);
	});

	it("names each live pi whose harness predates the census change or can't be dated, and only those", async () => {
		await says(SELF, { root: OLD });
		await says(1, { root: NEW });
		await says(2, { root: OLD });
		await says(3, { root: "/trees/gone" });
		await says(4, { root: OLD });
		await says(5, "{half");
		await says(6, { root: OLD });
		await says(".7.new", { root: OLD });
		const machine = facts([SELF, 1, 2, 3, 5, 6, 7], {
			[NEW]: true,
			[OLD]: false,
		});

		expect(
			await staleHarnesses({ loadedDir: loaded, self: SELF, facts: machine }),
		).toEqual([
			{ pid: 2, root: OLD, why: "before the census change" },
			{ pid: 3, root: "/trees/gone", why: "its root can't be dated" },
			{ pid: 5, why: "its file names no root" },
			{ pid: 6, root: OLD, why: "before the census change" },
		]);
		// Pid 4 has ended, and each root is dated once however many pis run it.
		expect(machine.holds.mock.calls.map(([root]) => root).sort()).toEqual(
			["/trees/gone", NEW, OLD].sort(),
		);
		expect(machine.holds).toHaveBeenCalledWith(OLD, CENSUS_COMMIT);
	});

	it("refuses a folder it can't read rather than taking it as nobody", async () => {
		await expect(
			staleHarnesses({
				loadedDir: join(dir, "missing"),
				facts: facts([], {}),
			}),
		).rejects.toThrow("Cannot tell which harness each pi runs");
	});
});

describe("rolloutFacts.holds, over real git", () => {
	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		}).trim();
	}

	it("tells a root past the commit from one before it, and can't date a folder that isn't a checkout", async () => {
		const repo = join(dir, "repo");
		await mkdir(repo);
		git(repo, "init", "-q");
		git(repo, "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "one");
		const before = git(repo, "rev-parse", "HEAD");
		git(repo, "commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "two");
		const census = git(repo, "rev-parse", "HEAD");

		expect(
			await rolloutFacts.holds(repo, census),
			"a root at the commit holds it",
		).toBe(true);
		git(repo, "checkout", "-q", before);
		expect(
			await rolloutFacts.holds(repo, census),
			"a root before the commit doesn't",
		).toBe(false);
		expect(await rolloutFacts.holds(repo, CENSUS_COMMIT)).toBeUndefined();
		expect(await rolloutFacts.holds(loaded, census)).toBeUndefined();
	});
});

describe("rolloutGate", () => {
	it("passes once every live pi has the change, asking git about a cleared root only once", async () => {
		await says(1, { root: NEW });
		await says(2, { root: NEW });
		const machine = facts([1, 2], { [NEW]: true });
		const gate = rolloutGate({ loadedDir: loaded, self: SELF, facts: machine });
		await gate();
		await gate();
		expect(machine.holds).toHaveBeenCalledTimes(1);
	});

	it("refuses naming every stale pid, and asks again about a root that wasn't cleared", async () => {
		await says(1, { root: NEW });
		await says(2, { root: OLD });
		const machine = facts([1, 2], { [NEW]: true, [OLD]: false });
		const gate = rolloutGate({ loadedDir: loaded, self: SELF, facts: machine });
		await expect(gate()).rejects.toThrow(
			refusalText([{ pid: 2, root: OLD, why: "before the census change" }]),
		);
		await expect(gate()).rejects.toThrow(`pid 2 (${OLD})`);
		expect(machine.holds.mock.calls.map(([root]) => root)).toEqual([
			NEW,
			OLD,
			OLD,
		]);
	});
});

describe("refusalText", () => {
	it("says what holds the host to one conversation and what to do about it", () => {
		const text = refusalText([
			{ pid: 2, root: OLD, why: "before the census change" },
			{ pid: 5, why: "its file names no root" },
		]);
		expect(text).toContain("2 live pis");
		expect(text).toContain(CENSUS_COMMIT.slice(0, 8));
		expect(text).toContain(`pid 2 (${OLD}): before the census change`);
		expect(text).toContain("pid 5: its file names no root");
		expect(text).toContain("Reload or end them");
	});
});

describe("hostRolloutGate", () => {
	it("reads the loaded folder of the install the host runs from", () => {
		expect(loadedFolderOf("/pkgs/harness/versions/abc")).toBe(
			"/pkgs/harness/loaded",
		);
	});

	it("keeps a host run from a tree to one conversation, saying where it runs", async () => {
		await expect(hostRolloutGate("/trees/mine")()).rejects.toThrow(
			"runs from /trees/mine, outside an installed version",
		);
	});
});
