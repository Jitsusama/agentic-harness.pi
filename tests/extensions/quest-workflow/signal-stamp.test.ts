import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installSignalStamp,
	readRecord,
} from "../../../extensions/quest-workflow/session-registry";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard, succeeded } from "./_helpers";

let tmpRoot: string;
const envGuard = createEnvGuard();
let savedState: string | undefined;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
function fakeCtx(sessionId: string) {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as Parameters<typeof handle>[2];
}

/**
 * Installed before the verb runs, so the verb's own install finds the
 * listeners already in and these deps are the ones that fire. A real
 * re-raise would send SIGHUP to the test runner.
 */
function installQuietly(): void {
	installSignalStamp({
		now: () => new Date("2026-09-23T20:00:00.000Z"),
		schedule: () => {},
		raise: () => {},
	});
}

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "signal-stamp-"));
	savedState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(tmpRoot, "state");
});

afterEach(() => {
	if (savedState !== undefined) process.env.XDG_STATE_HOME = savedState;
	else delete process.env.XDG_STATE_HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

async function loadQuest(sessionId: string): Promise<void> {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const created = succeeded(
		await handle(state, fakePi(), fakeCtx(sessionId), {
			action: "create",
			title: "Signalled Quest",
		}),
	);
	succeeded(
		await handle(state, fakePi(), fakeCtx(sessionId), {
			action: "load",
			id: (created.details as { id: string }).id,
		}),
	);
}

describe("the signal stamp after a quest load", () => {
	it("stamps the session that loaded the quest when its tab hangs up", async () => {
		// Most sessions start bare and load a quest later, so the stamp
		// has to follow the load verb and not only the launch path.
		installQuietly();
		await loadQuest("sess-loaded");
		process.emit("SIGHUP");
		expect(readRecord("sess-loaded")?.endReason).toBe("signalled");
	});

	it("starts listening when the load is the first thing to ask", async () => {
		const before = process.listenerCount("SIGHUP");
		await loadQuest("sess-loaded");
		expect(process.listenerCount("SIGHUP")).toBe(before + 1);
	});
});
