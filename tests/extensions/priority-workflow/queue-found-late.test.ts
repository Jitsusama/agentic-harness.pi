/**
 * A Mac names its queue folder through getconf, which can fail under
 * load, so a session may find its folder only on a later look. A folder
 * first found as a command is about to run holds that very command to
 * turns, rather than judging it by a queue its session never took.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	KEEP_MS,
	keepQueue,
	type Machine,
} from "../../../extensions/priority-workflow/index.ts";
import { queuedCommand } from "../../../lib/internal/priority/turn.ts";
import { ROOMY } from "../../lib/internal/priority/queue-folder.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

/** The folder getconf names, while it can. */
const named = vi.hoisted(() => ({ dir: undefined as string | undefined }));

vi.mock("../../../lib/internal/priority/folder.ts", async (original) => ({
	...(await original<
		typeof import("../../../lib/internal/priority/folder.ts")
	>()),
	machineQueueDir: () => named.dir,
}));

let root: string;
let handlers: Map<string, Handler>;

const machine: Machine = {
	processes: { isRunning: () => true, cgroupOf: () => undefined },
	room: async () => ROOMY,
	cgroupFor: () => undefined,
	rules: () => ({ buildsWaitForVmChecks: true }),
};

const ctx = {
	cwd: tmpdir(),
	sessionManager: { getSessionId: () => "session-a" },
};

const fire = (name: string, event: object = {}) =>
	handlers.get(name)?.({ type: name, ...event }, ctx);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "queue-found-late-"));
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	// The keep's tick comes only when a case moves the clock, so a case
	// that doesn't proves the command's own look finds the folder.
	vi.useFakeTimers();
	named.dir = undefined;
	handlers = new Map();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	keepQueue(pi, machine);
});

afterEach(async () => {
	await fire("session_shutdown");
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

it("holds heavy work to turns once a command finds the folder the session started without", async () => {
	await fire("session_start", { reason: "startup" });
	const before = queuedCommand("cargo build");

	named.dir = join(root, "jobs");
	await fire("tool_call", {
		toolName: "bash",
		toolCallId: "call-1",
		input: { command: "echo found" },
	});

	expect({ before, after: queuedCommand("cargo build") }).toEqual({
		before: "cargo build",
		after: expect.stringContaining(join(root, "jobs")),
	});
});

it("holds heavy work to turns once the keep's tick finds the folder, with no command between", async () => {
	await fire("session_start", { reason: "startup" });
	const before = queuedCommand("cargo build");

	named.dir = join(root, "jobs");
	vi.advanceTimersByTime(KEEP_MS);

	expect({ before, after: queuedCommand("cargo build") }).toEqual({
		before: "cargo build",
		after: expect.stringContaining(join(root, "jobs")),
	});
});
