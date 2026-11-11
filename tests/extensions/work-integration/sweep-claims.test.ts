/**
 * The unattended sweep holds for good only what holders claim for good,
 * and tells them what it took.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerTreeSweeps } from "../../../extensions/work-integration/sweep.ts";
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

it("holds for good only what is claimed for good, and says what it took", async () => {
	const events = createEventBus();
	events.on(WORK_TREE_CLAIMS, (data) => {
		const claims = data as TreeClaims;
		claims.paths.push("/src/repo/.worktrees/kept");
		claims.untilSpent?.push("/src/repo/.worktrees/spent");
	});
	const heard: string[] = [];
	events.on(WORK_TREES_SWEPT, (data) => {
		heard.push(...(data as SweptTrees).paths);
	});
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

	expect(given, "the claims the sweep held for good").toEqual([
		["/src/repo/.worktrees/kept"],
	]);
	expect(heard, "what holders heard was taken").toEqual([
		"/src/repo/.worktrees/spent",
	]);
});
