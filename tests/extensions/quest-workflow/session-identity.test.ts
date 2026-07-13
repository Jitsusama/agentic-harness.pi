import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attachCurrentSession,
	detachSessionIfOwner,
} from "../../../extensions/quest-workflow/lifecycle";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { parseQuestFrontMatter } from "../../../lib/quest/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return {
		setSessionName: () => {},
		appendEntry: () => {},
	} as unknown as Parameters<typeof handle>[1];
}
function fakeCtx(cwd: string) {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => "sess-1",
			isPersisted: () => true,
			getEntries: () => [],
		},
	} as unknown as Parameters<typeof handle>[2];
}
function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}
async function createQuest(state: ReturnType<typeof buildState>) {
	const r = await handle(state, fakePi(), fakeCtx(tmpRoot), {
		action: "create",
		kind: "quest",
		title: "Identity",
	});
	if (!r.ok) throw new Error("create failed");
	return state.questDir as string;
}
function sessionOf(dir: string, id: string) {
	const parsed = parseQuestFrontMatter(
		readFileSync(join(dir, "README.md"), "utf8"),
	);
	return parsed?.frontMatter.sessions.find((s) => s.id === id);
}

const IDENTITY = {
	instanceId: "inst-1",
	process: { hostId: "host-a", pid: 1234, startToken: "tok-1" },
	terminal: { driverId: "wezterm", value: "3", scope: "/sock/gui-1" },
};

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "session-identity-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("attachCurrentSession identity capture", () => {
	it("records the process, instance and terminal identity passed in", async () => {
		const state = buildState();
		const dir = await createQuest(state);
		attachCurrentSession(state, { id: "sess-1", cwd: tmpRoot, ...IDENTITY });
		const s = sessionOf(dir, "sess-1");
		expect(s?.instanceId).toBe("inst-1");
		expect(s?.process).toEqual(IDENTITY.process);
		expect(s?.terminal).toEqual(IDENTITY.terminal);
	});
});

describe("session-attach identity capture", () => {
	it("captures the current process identity when attaching the current session", async () => {
		const state = buildState();
		const dir = await createQuest(state);
		const r = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "session-attach",
		});
		expect(r.ok).toBe(true);
		const s = sessionOf(dir, "sess-1");
		expect(typeof s?.instanceId).toBe("string");
		expect(s?.instanceId?.length).toBeGreaterThan(0);
		expect(s?.process?.pid).toBe(process.pid);
	});

	it("does not attribute the current identity to a different session id", async () => {
		const state = buildState();
		const dir = await createQuest(state);
		const r = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "session-attach",
			sessionId: "sess-OTHER",
		});
		expect(r.ok).toBe(true);
		const s = sessionOf(dir, "sess-OTHER");
		expect(s?.instanceId).toBeUndefined();
		expect(s?.process).toBeUndefined();
	});
});

describe("detachSessionIfOwner (instance lease)", () => {
	it("detaches when the caller's instance owns the record", async () => {
		const state = buildState();
		const dir = await createQuest(state);
		attachCurrentSession(state, { id: "sess-1", ...IDENTITY });
		const r = detachSessionIfOwner(dir, "sess-1", "inst-1");
		expect(r.ok && r.detached).toBe(true);
		expect(sessionOf(dir, "sess-1")?.status).toBe("detached");
	});

	it("leaves the record active when a different instance owns it", async () => {
		const state = buildState();
		const dir = await createQuest(state);
		attachCurrentSession(state, { id: "sess-1", ...IDENTITY });
		const r = detachSessionIfOwner(dir, "sess-1", "inst-OTHER");
		expect(r.ok && r.detached).toBe(false);
		expect(sessionOf(dir, "sess-1")?.status).toBe("active");
	});

	it("detaches a legacy record that carries no instance id", async () => {
		const state = buildState();
		const dir = await createQuest(state);
		attachCurrentSession(state, { id: "sess-1", cwd: tmpRoot });
		const r = detachSessionIfOwner(dir, "sess-1", "inst-1");
		expect(r.ok && r.detached).toBe(true);
		expect(sessionOf(dir, "sess-1")?.status).toBe("detached");
	});
});
