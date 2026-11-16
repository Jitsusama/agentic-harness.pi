/**
 * What the fleet housekeeping tests share: a state directory of their
 * own, a session started the way pi starts one, and fleets on disk in
 * each shape the housekeeping decides on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import subagentWorkflow from "../../../extensions/subagent-workflow/index.ts";
import { createFleetLedger } from "../../../lib/subagent/fleet.ts";
import { ReviewerArtifactsStore } from "../../../lib/subagent/index.ts";
import { noSuchProcess } from "../../support/processes.ts";
import { activateWith } from "../support/review-extension.ts";

let root: string;

/** What the person has been told in the test running now. */
export const said: string[] = [];

/** What was written to the terminal directly, which must stay empty. */
const behind: string[] = [];

/** A session with a screen, whose notices are what the person is told. */
const screen = {
	hasUI: true,
	ui: { notify: (text: string) => said.push(text) },
};

/**
 * Give each test in the calling file a state directory of its own and a
 * screen whose notices are kept, and hold it to writing nothing to the
 * terminal directly.
 */
export function holdFleetState(): void {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fleet-sweep-"));
		// The extension resolves its state directory from the environment
		// on every call, which is what makes it redirectable at all.
		vi.stubEnv("XDG_STATE_HOME", root);
		// The person's own config is not this test's to read.
		vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
		said.length = 0;
		behind.length = 0;
		// Anything written to the terminal directly lands in pi's editor and
		// throws its picture of the screen out (lib/ui/aside.ts), so it is
		// kept apart from what the person is told, and must stay empty.
		vi.spyOn(console, "error").mockImplementation((line: unknown) => {
			behind.push(String(line));
		});
	});

	afterEach(() => {
		expect(behind).toEqual([]);
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});
}

/** Where the extension keeps its subagent state. */
export function stateDir(...parts: string[]): string {
	return join(root, "pi", "agentic-harness.pi", "subagent-workflow", ...parts);
}

/** A finished fleet's transcripts, old enough for the ordinary window. */
export function staleFleet(id: string): string {
	const paths = new ReviewerArtifactsStore(stateDir()).paths(id, "one");
	mkdirSync(join(paths.resultPath, ".."), { recursive: true });
	writeFileSync(paths.resultPath, JSON.stringify({ ok: true }), "utf8");
	// Aged by the caller rather than here, because writing the result
	// file above moves the run directory's mtime and this would then
	// be aging a directory that is about to look new again.
	return paths.runDir;
}

/**
 * A run the housekeeping must act on, so absence can be observed.
 *
 * Every case that asserts something did not happen needs a moment
 * that is definitely after the decision it denies, and there is no
 * such moment inside the thing being denied. This is one: its
 * supervisor is plainly gone, so it is acted on and announced, and
 * that announcement comes after every run has been decided and after
 * the sweep that runs before them.
 */
export async function alsoOrphaned(
	store: ReviewerArtifactsStore,
): Promise<void> {
	await orphaned(store, "zz-orphan");
}

/** A run whose supervisor is plainly gone, under the run id given. */
export async function orphaned(
	store: ReviewerArtifactsStore,
	runId: string,
): Promise<void> {
	const paths = await store.ensureReviewerDir(runId, "one");
	await store.writeJsonAtomic(paths.progressPath, {
		state: "running",
		activity: "thinking",
		updatedAt: new Date().toISOString(),
	});
	await store.writeJsonAtomic(paths.leasePath, {
		state: "running",
		supervisorPid: noSuchProcess(),
		supervisorStartedAt: 1_000_000,
		updatedAt: new Date().toISOString(),
	});
}

/** A day, which holds a whole number of every window these tests cross. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hold the clock at the start of the next day, and hand back that
 * moment, so a minute after it is still in the window it opens.
 */
export function holdTheClock(): number {
	vi.useFakeTimers({ toFake: ["Date"] });
	const opens = Math.ceil(Date.now() / DAY_MS) * DAY_MS;
	vi.setSystemTime(opens);
	return opens;
}

/** Wait until the housekeeping has said what it did. */
export async function finished(): Promise<void> {
	await vi.waitFor(() => expect(said.join(" ")).toContain("zz-orphan/one"), {
		timeout: 30_000,
	});
}

/** Age a path past every ordinary window. */
export async function age(path: string): Promise<void> {
	const long = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	await utimes(path, long, long);
}

/** Whether a line is about any of the fleets these tests hold. */
export function aboutFleets(line: string): boolean {
	return /fleet-\d/.test(line) || line.includes("from sessions that ended");
}

/** What a conversation holds before this start: nothing yet, or what it said. */
export const NEW: readonly { type: string }[] = [];
export const CAME_BACK: readonly { type: string }[] = [{ type: "message" }];

/**
 * Start the session the way pi starts one, as this conversation, and
 * hand back what it told the model. Given its entries, the session
 * says what it holds already, as pi's does. pi asks for resources once
 * the start has answered, which is when the look for orphans begins.
 */
export async function startSession(
	session?: string,
	entries?: readonly { type: string }[],
): Promise<{ customType: string; content: unknown }[]> {
	const stub = activateWith(subagentWorkflow);
	const started = stub.lifecycle.get("session_start");
	if (started === undefined) {
		throw new Error("the extension registered no session_start on pi.on");
	}
	const manager = {
		...(session !== undefined ? { getSessionId: () => session } : {}),
		...(entries !== undefined ? { getEntries: () => [...entries] } : {}),
	};
	const ctx =
		Object.keys(manager).length === 0
			? screen
			: { ...screen, sessionManager: manager };
	await started({ reason: "startup" }, ctx);
	await stub.lifecycle.get("resources_discover")?.({ reason: "startup" }, ctx);
	return stub.sent;
}

/** A fleet record as it reads back now. */
export async function recordOf(id: string) {
	const { runs } = await createFleetLedger(stateDir("fleets")).everyFleet();
	return runs.find((run) => run.id === id);
}
