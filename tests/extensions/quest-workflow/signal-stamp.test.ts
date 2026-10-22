import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installSignalStamp,
	readRecord,
} from "../../../extensions/quest-workflow/session-registry";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { parseQuestFrontMatter } from "../../../lib/quest/index";
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
		// A tab: only an interactive session is recorded for restore.
		hasUI: true,
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

/** Load a fresh quest in this session, answering with its directory. */
async function loadQuest(sessionId: string): Promise<string> {
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
	return state.questDir as string;
}

function readmeStatus(questDir: string, sessionId: string) {
	const parsed = parseQuestFrontMatter(
		readFileSync(join(questDir, "README.md"), "utf8"),
	);
	return parsed?.frontMatter.sessions.find((s) => s.id === sessionId)?.status;
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

	it("releases the session on its quest in the same breath", async () => {
		// pi exits right after the signal, usually before its own
		// shutdown hook reaches the README, which is how closed tabs kept
		// reading active. The listener is the one step that always runs.
		installQuietly();
		const questDir = await loadQuest("sess-loaded");
		expect(readmeStatus(questDir, "sess-loaded")).toBe("active");
		process.emit("SIGHUP");
		expect(readmeStatus(questDir, "sess-loaded")).toBe("detached");
	});

	it("starts listening when the load is the first thing to ask", async () => {
		const before = process.listenerCount("SIGHUP");
		await loadQuest("sess-loaded");
		expect(process.listenerCount("SIGHUP")).toBe(before + 1);
	});
});

describe("a tab that starts by creating a quest", () => {
	async function create(
		state: ReturnType<typeof createQuestState>,
		title: string,
	) {
		succeeded(
			await handle(state, fakePi(), fakeCtx("sess-new"), {
				action: "create",
				title,
			}),
		);
		return state.questDir as string;
	}

	it("is recorded for restore, and stamped when it hangs up", async () => {
		installQuietly();
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const questDir = await create(state, "Fresh Quest");

		expect(readRecord("sess-new")?.quest).toBe(state.questId);
		expect(readmeStatus(questDir, "sess-new")).toBe("active");
		process.emit("SIGHUP");
		expect(readRecord("sess-new")?.endReason).toBe("signalled");
	});

	it("stays on the quest it was on when it creates another", async () => {
		// A session on a quest that creates one is filing it for later or
		// for another session; moving it there took it off its own work.
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const first = await create(state, "First Quest");
		const made = succeeded(
			await handle(state, fakePi(), fakeCtx("sess-new"), {
				action: "create",
				title: "Second Quest",
			}),
		);
		const second = join(state.questsRoot, String(made.details?.id));

		expect(state.questDir).toBe(first);
		expect(made.message).toContain("This session stays on");
		expect(readmeStatus(first, "sess-new")).toBe("active");
		expect(readmeStatus(second, "sess-new")).toBeUndefined();
		expect(readRecord("sess-new")?.quest).toBe(state.questId);
	});
});
