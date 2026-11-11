/**
 * The unattended sweep holds every live quest's trees for good, and
 * tells holders what it took.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { answerTreeClaims } from "../../../extensions/quest-workflow/claims.ts";
import {
	registerTreeSweeps,
	useSigns,
} from "../../../extensions/work-integration/sweep.ts";
import {
	type SweptTrees,
	type TreeClaims,
	WORK_TREE_CLAIMS,
	WORK_TREES_SWEPT,
} from "../../../lib/core/work/index.ts";
import { installTestHost } from "../../support/session-host.ts";

/** The claims each sweep was given. */
const given: (readonly string[])[] = [];

vi.mock("../../../lib/core/work/sweep.ts", () => ({
	sweepEndedTrees: async (deps: { claims: readonly string[] }) => {
		given.push([...deps.claims]);
		return {
			taken: [{ path: "/src/repo/.worktrees/spent", branch: "spent" }],
			refused: [],
			kept: [],
			dropped: [],
		};
	},
}));

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

it("holds a live quest's tree for good, though no process sits in it", async () => {
	// A hosted conversation's folder is no process's working folder, so
	// only its quest's claim keeps its tree: offered as held until spent,
	// one sweep on 11 November took a hosted conversation's tree.
	const events = createEventBus();
	const tree = "/src/repo/.worktrees/hosted";
	answerTreeClaims({ events } as never, liveQuestListing(tree));

	await sweepOn(events);

	expect(given, "the claims the sweep held for good").toEqual([[tree]]);
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

	expect(given, "the claims the sweep held for good").toEqual([
		["/src/repo/.worktrees/kept"],
	]);
	expect(heard, "what holders heard was taken").toEqual([
		"/src/repo/.worktrees/spent",
	]);
});
