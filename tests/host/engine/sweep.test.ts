/** The key-wide sweep a supervisor runs for its child hosts. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	KEPT_FILE,
	STRAY_FOR_MS,
} from "../../../host/engine/carried-shells.ts";
import { LEFT_FILE } from "../../../host/engine/left-running.ts";
import { sweepUnheld } from "../../../host/engine/sweep.ts";
import {
	conversationMarker,
	type ProcessTable,
} from "../../../host/engine/tool-children.ts";
import type { CarriedShell } from "../../../lib/internal/shell/carried.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";

const KEY = "work-background";
/** A child host that has gone: pid 7, started at tick 100. */
const GONE = { key: KEY, mark: "7:100" };
const NOW = 10 * STRAY_FOR_MS;
const NONE = { marks: new Set<string>(), groups: new Set<number>() };

interface Process {
	readonly group: number;
	readonly env: Record<string, string>;
}

/** A process table of `processes`, this process pid 1, recording each kill. */
function table(processes: Record<number, Process>) {
	const live = new Map(
		Object.entries(processes).map(([pid, p]) => [Number(pid), p]),
	);
	const killed: number[] = [];
	const fake: ProcessTable = {
		self: 1,
		pids: () => [...live.keys()],
		environ: async (pid) => live.get(pid)?.env,
		group: (pid) => live.get(pid)?.group,
		cgroup: () => undefined,
		started: (pid) => (pid === 1 ? 0 : undefined),
		kill: (target) => {
			if (!("group" in target)) return;
			killed.push(target.group);
			for (const [pid, p] of live)
				if (p.group === target.group) live.delete(pid);
		},
	};
	return { fake, killed };
}

/** A process of a conversation the gone child ran, started by call `mark`. */
function left(session: string, group: number, mark?: string): Process {
	return {
		group,
		env: {
			...conversationMarker(session, GONE),
			...(mark ? { [CALL_VARIABLE]: mark } : {}),
		},
	};
}

/** A shell a restart carried, started long enough ago to be due. */
function carried(session: string, mark: string) {
	const work: CarriedShell = {
		kind: "shell",
		keep: `/keep/${mark}`,
		pid: 4000,
		mark,
		startedAt: 0,
	};
	return { session, job: `job-${mark}`, label: mark, at: 0, work };
}

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "sweep-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function sweeping(stopped: string[] = []) {
	return {
		stateDir: root,
		carried: () => NONE,
		say: vi.fn<(line: string) => void>(),
		report: vi.fn<(error: unknown) => void>(),
		now: () => NOW,
		shells: {
			running: () => true,
			stop: (work: CarriedShell) => {
				stopped.push(work.mark);
			},
			recorded: () => [],
			ownCgroup: () => "0::/test\n",
			scoped: true,
		},
	};
}

describe("sweeping a key for what no live host holds", () => {
	it("ends what a gone child's tools left, sparing a conversation being started for", async () => {
		const { fake, killed } = table({
			1: { group: 1, env: {} },
			10: left("unheld", 10),
			20: left("starting", 20),
		});
		const swept = await sweepUnheld(KEY, new Set(["starting"]), {
			...sweeping(),
			table: fake,
		});
		expect(killed).toEqual([10]);
		expect(swept.reaped.groups).toEqual([10]);
	});

	it("spares what a park kept, from a conversation's own folder and the key's", async () => {
		await mkdir(join(root, "one"));
		await writeFile(
			join(root, "one", LEFT_FILE),
			JSON.stringify([{ session: "one", mark: "kept-one", at: NOW - 1 }]),
		);
		await writeFile(
			join(root, LEFT_FILE),
			JSON.stringify([{ session: "two", mark: "kept-two", at: NOW - 1 }]),
		);
		const { fake, killed } = table({
			1: { group: 1, env: {} },
			10: left("one", 10, "kept-one"),
			20: left("two", 20, "kept-two"),
			30: left("three", 30, "not-kept"),
		});
		await sweepUnheld(KEY, new Set(), { ...sweeping(), table: fake });
		expect(killed).toEqual([30]);
	});

	it("stops a due carried call nobody holds, in each conversation's folder and the key's", async () => {
		await mkdir(join(root, "one"));
		await mkdir(join(root, "two"));
		await writeFile(
			join(root, "one", KEPT_FILE),
			JSON.stringify([carried("one", "call-one")]),
		);
		await writeFile(
			join(root, "two", KEPT_FILE),
			JSON.stringify([carried("two", "call-two")]),
		);
		await writeFile(
			join(root, KEPT_FILE),
			JSON.stringify([carried("three", "call-three")]),
		);
		const stopped: string[] = [];
		const { fake } = table({ 1: { group: 1, env: {} } });
		const swept = await sweepUnheld(KEY, new Set(["two"]), {
			...sweeping(stopped),
			table: fake,
		});
		expect(stopped.sort()).toEqual(["call-one", "call-three"]);
		expect(swept.folders).toBe(3);
		const kept: unknown = JSON.parse(
			await readFile(join(root, "two", KEPT_FILE), "utf8"),
		);
		expect(kept).toEqual([carried("two", "call-two")]);
	});

	it("sweeps a key with no engine folder yet, saying nothing", async () => {
		const options = sweeping();
		const { fake } = table({ 1: { group: 1, env: {} } });
		await sweepUnheld(KEY, new Set(), {
			...options,
			stateDir: join(root, "none"),
			table: fake,
		});
		expect(options.report).not.toHaveBeenCalled();
	});
});
