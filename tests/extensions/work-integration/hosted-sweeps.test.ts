/** Two conversations in one host each keep their own tree sweeps. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerTreeSweeps } from "../../../extensions/work-integration/sweep.ts";
import { ambientSession } from "../../../lib/core/session/index.ts";
import { installTestHost } from "../../support/session-host.ts";

/** Which conversation each sweep ran as. */
const sweptAs: (string | undefined)[] = [];

vi.mock("../../../lib/core/work/sweep.ts", () => ({
	sweepEndedTrees: async () => {
		sweptAs.push(ambientSession());
		return { taken: [], refused: [], kept: [] };
	},
}));

const FIRST_SWEEP_MS = 3 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

type Handler = (event: unknown, ctx: unknown) => unknown;

let root: string;
let host: ReturnType<typeof installTestHost>;

/** The extension's hooks, called as a host calls them for one conversation. */
function loaded() {
	const hooks = new Map<string, Handler[]>();
	registerTreeSweeps({
		on: (name: string, fn: Handler) =>
			hooks.set(name, [...(hooks.get(name) ?? []), fn]),
		events: createEventBus(),
	} as never);
	const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id } });
	return (name: string, id: string) => {
		for (const fn of hooks.get(name) ?? []) fn({ reason: "startup" }, ctx(id));
	};
}

/** Let the timers fire and each sweep's log line be written. */
async function after(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hosted-sweeps-"));
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
	vi.useFakeTimers();
	sweptAs.length = 0;
	host = installTestHost();
});
afterEach(() => {
	host.dispose();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

it("sweeps each conversation as itself, B's start and close leaving A's", async () => {
	const hook = loaded();
	hook("session_start", "a");
	hook("session_start", "b");
	await after(FIRST_SWEEP_MS);
	expect([...sweptAs].sort()).toEqual(["a", "b"]);

	hook("session_shutdown", "b");
	sweptAs.length = 0;
	await after(SWEEP_EVERY_MS);

	expect(sweptAs).toEqual(["a"]);
});
