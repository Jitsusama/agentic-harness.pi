/**
 * The unattended sweep holds every live quest's trees only until spent,
 * what else claims a tree for good, and tells holders what it took.
 */
import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { answerTreeClaims } from "../../../extensions/quest-workflow/claims.ts";
import {
	registerTreeSweeps,
	seesEveryProcess,
	useSigns,
} from "../../../extensions/work-integration/sweep.ts";
import {
	type SweptTrees,
	type TreeClaims,
	WORK_TREE_CLAIMS,
	WORK_TREES_SWEPT,
} from "../../../lib/core/work/index.ts";
import type { SweepClaims } from "../../../lib/core/work/sweep.ts";
import { installTestHost } from "../../support/session-host.ts";

/** The claims each sweep was given. */
const given: SweepClaims[] = [];

/** The rest each sweep was asked to keep. */
const rests: (number | undefined)[] = [];

/** Why the next sweep does nothing, when it should, as the library says. */
const idle: { rested?: string; skipped?: string } = {};

vi.mock("../../../lib/core/work/sweep.ts", () => ({
	sweepEndedTrees: async (deps: {
		claims: SweepClaims | (() => SweepClaims);
		restMs?: number;
	}) => {
		rests.push(deps.restMs);
		const none = { taken: [], refused: [], kept: [], dropped: [] };
		// As the library does: claims are asked only by a sweep that runs.
		if (idle.rested !== undefined) return { ...none, rested: idle.rested };
		if (idle.skipped !== undefined) return { ...none, skipped: idle.skipped };
		given.push(typeof deps.claims === "function" ? deps.claims() : deps.claims);
		return {
			...none,
			taken: [{ path: "/src/repo/.worktrees/spent", branch: "spent" }],
		};
	},
}));

/** The sweep's log, as the extension writes it under the stubbed state. */
function sweepLog(): string {
	return join(root, "state", "pi", "agentic-harness.pi", "work", "sweep.log");
}

const FIRST_SWEEP_MS = 3 * 60 * 1000;

type Handler = (event: unknown, ctx: unknown) => unknown;

let root: string;
let host: ReturnType<typeof installTestHost>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sweep-claims-"));
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
	vi.useFakeTimers();
	given.length = 0;
	rests.length = 0;
	delete idle.rested;
	delete idle.skipped;
	host = installTestHost();
});
afterEach(() => {
	host.dispose();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** Start one session's sweeps on the bus and let the first one run. */
async function sweepOn(events: ReturnType<typeof createEventBus>) {
	const hooks = new Map<string, Handler[]>();
	registerTreeSweeps({
		on: (name: string, fn: Handler) =>
			hooks.set(name, [...(hooks.get(name) ?? []), fn]),
		events,
	} as never);
	for (const fn of hooks.get("session_start") ?? []) {
		fn({ reason: "startup" }, { sessionManager: { getSessionId: () => "a" } });
	}
	await vi.advanceTimersByTimeAsync(FIRST_SWEEP_MS);
}

/** A quests root holding one active quest that lists `path`. */
function liveQuestListing(path: string): string {
	const quests = join(root, "quests");
	const id = "QEST-20260731-AAAAAA";
	mkdirSync(join(quests, id), { recursive: true });
	writeFileSync(
		join(quests, id, "README.md"),
		`---\nid: ${id}\nkind: quest\nstatus: active\npriority: active\n` +
			"rank: 1\nstarted: 2026-07-31\nupdated: 2026-07-31\n" +
			`trees:\n  - path: ${path}\n    providerId: git-worktree\n` +
			`    repoRoot: ${path}\n    origin: cut\n` +
			"---\n\n# Holding trees\n\n## Summary\n\nA quest with a tree.\n",
	);
	return quests;
}

it("holds a live quest's tree only until spent", async () => {
	// A hosted conversation's folder counts as in use by the host's
	// roster, below, so its quest's claim needn't hold its tree for good.
	const events = createEventBus();
	const tree = "/src/repo/.worktrees/hosted";
	answerTreeClaims({ events } as never, liveQuestListing(tree));

	await sweepOn(events);

	expect(given, "the claims the sweep was given").toEqual([
		{ held: [], untilSpent: [tree] },
	]);
});

it("counts a hosted conversation's folder as in use, though its host stands elsewhere", async () => {
	// The sweep took QCXZEB's folder while its host held it open, as no
	// process's working folder named it and its tree's record no session.
	const rosters = join(
		root,
		"state",
		"pi",
		"agentic-harness.pi",
		"host-rosters",
	);
	mkdirSync(rosters, { recursive: true });
	const folder = "/src/repo/.worktrees/hosted";
	writeFileSync(
		join(rosters, "work-background.json"),
		JSON.stringify({
			v: 1,
			key: "work-background",
			sessions: [
				{
					sessionId: "01a1b8be-44ff-77aa-be03-5ca923cefb70",
					file: "/home/someone/.pi/sessions/hosted.jsonl",
					cwd: folder,
					attended: false,
					since: "2026-11-11T00:30:00.000Z",
				},
			],
		}),
	);

	const folders = (await useSigns().sessionFolders?.()) ?? [];

	expect(folders, "the folders live sessions work in").toContain(folder);
});

// Only where every process is seen, as the fence's own namespace isn't,
// nor a /proc that hides the machine's first process.
it.runIf((await seesEveryProcess()) && existsSync("/proc/1"))(
	"says which trees a process works in or holds a file open in, from the kernel's own links",
	async () => {
		// The kernel names real paths, so the trees are named by theirs.
		const trees = realpathSync(root);
		const [worked, opened, free] = ["worked", "opened", "free"].map((name) => {
			const tree = join(trees, name);
			mkdirSync(tree);
			return tree;
		});
		writeFileSync(join(opened ?? "", "held.txt"), "open\n");
		const held = openSync(join(opened ?? "", "held.txt"), "r");
		const sitting = spawn("sleep", ["60"], { cwd: worked, stdio: "ignore" });
		try {
			const busy = await useSigns().busyAmong?.([
				worked ?? "",
				opened ?? "",
				free ?? "",
			]);

			expect(
				[...(busy ?? [])].sort(),
				"the trees a process works in or holds a file open in",
			).toEqual([opened, worked].sort());
		} finally {
			sitting.kill();
			closeSync(held);
		}
	},
);

it("asks every sweep to rest 20 minutes after any sweep ends", async () => {
	await sweepOn(createEventBus());

	expect(rests, "the rest each sweep was asked for").toEqual([20 * 60 * 1000]);
});

it("writes no line for a sweep that rested", async () => {
	idle.rested = "a sweep ended 60 s ago";

	await sweepOn(createEventBus());

	expect(existsSync(sweepLog()), "a log written for a sweep that rested").toBe(
		false,
	);
});

it("asks nobody for claims when it rests or another sweep holds the lock", async () => {
	// Asking makes each quest sign its whole tree on a host's thread, and
	// sixty conversations' first sweeps asking at once held the background
	// host past its watchdog on 18 November, though all but one skipped.
	let asked = 0;
	for (const why of ["rested", "skipped"] as const) {
		delete idle.rested;
		delete idle.skipped;
		idle[why] = "not now";
		const events = createEventBus();
		events.on(WORK_TREE_CLAIMS, () => {
			asked++;
		});

		await sweepOn(events);
	}

	expect(rests, "the sweeps that were started").toHaveLength(2);
	expect(asked, "times a sweep that didn't run asked for claims").toBe(0);
});

it("says when another sweep held the lock", async () => {
	idle.skipped = "another sweep is running, pid 4242";

	await sweepOn(createEventBus());

	expect(readFileSync(sweepLog(), "utf8")).toContain(
		'"skipped":"another sweep is running, pid 4242"',
	);
});

it("says what it took to whoever listed it", async () => {
	const events = createEventBus();
	events.on(WORK_TREE_CLAIMS, (data) => {
		(data as TreeClaims).paths.push("/src/repo/.worktrees/kept");
	});
	const heard: string[] = [];
	events.on(WORK_TREES_SWEPT, (data) => {
		heard.push(...(data as SweptTrees).paths);
	});

	await sweepOn(events);

	expect(given, "the claims the sweep was given").toEqual([
		{ held: ["/src/repo/.worktrees/kept"], untilSpent: [] },
	]);
	expect(heard, "what holders heard was taken").toEqual([
		"/src/repo/.worktrees/spent",
	]);
});
