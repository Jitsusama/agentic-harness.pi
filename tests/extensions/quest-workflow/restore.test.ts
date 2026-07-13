import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { registerBuiltinTerminalDrivers } from "../../../lib/terminal/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
function fakeCtx(sessionId = "sess-1") {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as Parameters<typeof handle>[2];
}
function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}
async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
): Promise<string> {
	const result = await handle(state, fakePi(), fakeCtx(), {
		action: "create",
		title,
	});
	if (!result.ok) throw new Error(result.guidance);
	return (result.details as { id: string }).id;
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
let savedPane: string | undefined;
let savedSocket: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "restore-"));
	savedHome = process.env.HOME;
	savedPane = process.env.WEZTERM_PANE;
	savedSocket = process.env.WEZTERM_UNIX_SOCKET;
	process.env.HOME = tmpRoot;
	registerBuiltinTerminalDrivers();
});
afterEach(() => {
	for (const [key, val] of [
		["HOME", savedHome],
		["WEZTERM_PANE", savedPane],
		["WEZTERM_UNIX_SOCKET", savedSocket],
	] as const) {
		if (val !== undefined) process.env[key] = val;
		else delete process.env[key];
	}
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("restore verb", () => {
	it("reports there is no workspace when no terminal is active", async () => {
		delete process.env.WEZTERM_PANE;
		delete process.env.WEZTERM_UNIX_SOCKET;
		const state = buildState();
		const result = await handle(state, fakePi(), fakeCtx(), {
			action: "restore",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.message.toLowerCase()).toContain("terminal");
	});

	it("lists a session recorded on load once its pane is gone", async () => {
		// A faked wezterm terminal so load records a workspace entry.
		process.env.WEZTERM_PANE = "42";
		process.env.WEZTERM_UNIX_SOCKET = "/tmp/wez-sock";
		const state = buildState();
		const quest = await createQuest(state, "Recorded Quest");
		// Load records the current session into the workspace snapshot.
		const loaded = await handle(state, fakePi(), fakeCtx("sess-A"), {
			action: "load",
			id: quest,
		});
		expect(loaded.ok).toBe(true);

		const result = await handle(state, fakePi(), fakeCtx("sess-A"), {
			action: "restore",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		// The pane cannot be probed live (no wezterm binary), so the
		// recorded session is offered for restore with a resume recipe.
		expect(result.message).toContain(quest);
		expect(result.message).toContain("pi --session 'sess-A'");
	});
});
