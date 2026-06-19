import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	clearTerminalDrivers,
	registerTerminalDriver,
	type TerminalDriver,
} from "../../../lib/terminal/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;
let savedHome: string | undefined;
let spawned: { command: string; cwd: string } | undefined;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
function fakeCtx(cwd: string, sessionId: string) {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId, isPersisted: () => true },
	} as unknown as Parameters<typeof handle>[2];
}
function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

// Write a session log so deriveLiveness finds an activity timestamp.
function writeLog(id: string, ageMs: number) {
	const dir = join(tmpRoot, ".pi", "agent", "sessions", "store-sub");
	mkdirSync(dir, { recursive: true });
	const ts = new Date(Date.now() - ageMs).toISOString();
	writeFileSync(
		join(dir, `2026-06-04T10-00-00-000Z_${id}.jsonl`),
		JSON.stringify({ timestamp: ts }),
	);
}

const envGuard = createEnvGuard();
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "spawn-resume-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
	spawned = undefined;
	clearTerminalDrivers();
	const fake: TerminalDriver = {
		id: "fake",
		available: () => true,
		async spawn(req) {
			spawned = { command: req.command, cwd: req.cwd };
		},
	};
	registerTerminalDriver(fake);
});
afterEach(() => {
	clearTerminalDrivers();
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

async function questWithIdleSession() {
	const state = buildState();
	const created = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
		action: "create",
		title: "Alpha",
	});
	if (!created.ok) throw new Error(created.guidance);
	const id = state.questId as string;
	// Attach an idle session (active status, log written an hour ago).
	await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
		action: "session-attach",
		sessionId: "idle-1",
	});
	writeLog("idle-1", 60 * 60 * 1000);
	return { state, id };
}

describe("spawn resume", () => {
	it("resumes the idle session and announces its staleness", async () => {
		const { state, id } = await questWithIdleSession();
		// A different current session id, so the idle one is resumable.
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn-tab",
			id,
		});
		expect(result.ok).toBe(true);
		expect(spawned?.command).toBe("pi --session idle-1");
		if (!result.ok) throw new Error("expected ok");
		expect(result.message).toContain("Resuming idle session idle-1");
		expect(result.message).toContain("ago");
	});

	it("suppresses the resume note when an explicit command is given", async () => {
		const { state, id } = await questWithIdleSession();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn-tab",
			id,
			command: "pi --model x",
		});
		expect(result.ok).toBe(true);
		expect(spawned?.command).toBe("pi --model x");
		if (!result.ok) throw new Error("expected ok");
		expect(result.message).not.toContain("Resuming");
	});
});
