/**
 * The look for orphaned subagents waits until the session is ready.
 *
 * It is the machine's look rather than the session's, and on a wake
 * on 15 November it held the thread for 1.3 s of the first 6.5 s,
 * while that session and its neighbours were still starting. pi asks
 * for resources once every extension's session start has answered,
 * so the look begins after that ask, and after the fleet sweep, which
 * it must never run beside.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentWorkflow from "../../../extensions/subagent-workflow/index.ts";
import {
	ReviewerArtifactsStore,
	type ReviewerRunPaths,
} from "../../../lib/subagent/artifacts.ts";
import { noSuchProcess } from "../../support/processes.ts";
import { quietFor, until } from "../../support/until.ts";
import { activateWith } from "../support/review-extension.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "orphans-ready-"));
	// The extension resolves its state directory from the environment
	// on every call, which is what makes it redirectable at all.
	vi.stubEnv("XDG_STATE_HOME", root);
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
	// Anything said goes to the terminal in a session without a screen,
	// which is not this test's to fill.
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** Where the extension keeps its subagent state. */
function stateDir(): string {
	return join(root, "pi", "agentic-harness.pi", "subagent-workflow");
}

/** A subagent whose supervisor is plainly gone. */
async function orphaned(): Promise<ReviewerRunPaths> {
	const store = new ReviewerArtifactsStore(stateDir());
	const paths = await store.ensureReviewerDir("fleet-orphaned", "one");
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
	return paths;
}

/** Whether a session has claimed the machine's walk named `name`. */
function claimed(name: string): boolean {
	return readdirSync(stateDir()).some((entry) =>
		entry.startsWith(`.${name}-walked-`),
	);
}

/** A lifecycle handler the extension registered, or a failure naming it. */
function handler(stub: ReturnType<typeof activateWith>, event: string) {
	const registered = stub.lifecycle.get(event);
	if (registered === undefined) {
		throw new Error(`the extension registered no ${event} on pi.on`);
	}
	return registered;
}

describe("the look for orphaned subagents", () => {
	it("waits for the session to be ready before it begins", async () => {
		const paths = await orphaned();
		const stub = activateWith(subagentWorkflow);

		await handler(stub, "session_start")({ reason: "startup" }, {});
		await until("the fleet sweep to claim its window", () => claimed("sweep"));
		// Absence, so a real wait: long beside the few milliseconds the
		// look took to begin once the sweep was done, when it began at
		// the session's start.
		await quietFor(100, 5);

		expect(claimed("orphans"), "the look claimed its window").toBe(false);
		expect(existsSync(paths.cancelPath), "the orphan was asked to stop").toBe(
			false,
		);

		await handler(stub, "resources_discover")({ reason: "startup" }, {});

		await until(
			"the orphan to be asked to stop",
			() => existsSync(paths.cancelPath),
			10_000,
		);
	});
});
