import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveRecord } from "../../../extensions/quest-workflow/session-registry";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	closeRecord,
	openRecord,
} from "../../../lib/internal/quest/session-registry";
import {
	clearTerminalDrivers,
	registerBuiltinTerminalDrivers,
	registerTerminalDriver,
	type TerminalDriver,
	type TerminalSessionHandle,
	type TerminalTypeCapability,
} from "../../../lib/terminal/index";
import { createEnvGuard, succeeded } from "./_helpers";

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
let savedState: string | undefined;
let savedPane: string | undefined;
let savedSocket: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "restore-"));
	savedHome = process.env.HOME;
	savedState = process.env.XDG_STATE_HOME;
	savedPane = process.env.WEZTERM_PANE;
	savedSocket = process.env.WEZTERM_UNIX_SOCKET;
	process.env.HOME = tmpRoot;
	process.env.XDG_STATE_HOME = join(tmpRoot, "state");
	registerBuiltinTerminalDrivers();
});
afterEach(() => {
	for (const [key, val] of [
		["HOME", savedHome],
		["XDG_STATE_HOME", savedState],
		["WEZTERM_PANE", savedPane],
		["WEZTERM_UNIX_SOCKET", savedSocket],
	] as const) {
		if (val !== undefined) process.env[key] = val;
		else delete process.env[key];
	}
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

/** A record for a session lost with the machine it ran on. */
function lostSession(sessionId: string, questId: string) {
	return closeRecord(
		openRecord({
			sessionId,
			instanceId: "inst-gone",
			cwd: tmpRoot,
			questId,
			now: new Date("2026-07-28T18:00:00.000Z"),
		}),
		"died",
		new Date("2026-07-28T18:30:00.000Z"),
	);
}

async function restoreNow() {
	return succeeded(
		await handle(buildState(), fakePi(), fakeCtx(), { action: "restore" }),
	);
}

describe("restore verb", () => {
	it("works without a terminal that reports a workspace", async () => {
		// The old restore keyed its snapshot by the mux socket, which
		// carries the gui process id, so a relaunch always minted a key
		// that matched nothing and the tabs from before were unreachable.
		// Nothing about a lost session depends on the terminal asked.
		delete process.env.WEZTERM_PANE;
		delete process.env.WEZTERM_UNIX_SOCKET;
		saveRecord(lostSession("sess-A", "QEST-1"));
		expect((await restoreNow()).message).toContain("pi --session 'sess-A'");
	});

	it("offers back a session lost with its terminal", async () => {
		saveRecord(lostSession("sess-A", "QEST-1"));
		const result = await restoreNow();
		expect(result.message).toContain("QEST-1");
		expect(result.message).toContain("pi --session 'sess-A'");
	});

	it("does not offer a session that is still running", async () => {
		// The session a load records is this very process, which probes
		// alive. Offering it back is how restore came to propose tabs
		// that were on screen the whole time.
		process.env.WEZTERM_PANE = "42";
		process.env.WEZTERM_UNIX_SOCKET = "/tmp/wez-sock";
		const state = buildState();
		const quest = await createQuest(state, "Recorded Quest");
		succeeded(
			await handle(state, fakePi(), fakeCtx("sess-A"), {
				action: "load",
				id: quest,
			}),
		);
		expect((await restoreNow()).message).toContain("nothing to restore");
	});

	it("reopens by typing into a shell, not by spawning the command", async () => {
		// Handing the resume line to the spawn primitive runs it under a
		// non-interactive shell, which skips the startup files that put
		// the right pi on PATH. Typing into a login shell is what a
		// person does, and is the only thing that works.
		const typed: { pane: string; text: string }[] = [];
		let spawnedCommand: string | undefined | "unset" = "unset";
		clearTerminalDrivers();
		const driver: TerminalDriver & TerminalTypeCapability = {
			id: "faketerm",
			available: () => true,
			async spawn(request) {
				spawnedCommand = request.command;
				return {
					driverId: "faketerm",
					kind: "fake-pane",
					hostId: "here",
					value: "7",
				};
			},
			async typeInto(handle: TerminalSessionHandle, text: string) {
				typed.push({ pane: handle.value, text });
			},
		};
		registerTerminalDriver(driver);
		saveRecord(lostSession("sess-A", "QEST-1"));

		const result = succeeded(
			await handle(buildState(), fakePi(), fakeCtx(), {
				action: "restore",
				force: true,
			}),
		);
		expect(spawnedCommand).toBeUndefined();
		expect(typed).toEqual([{ pane: "7", text: "pi --session sess-A\n" }]);
		expect(result.message).toContain("Reopened 1 of 1");
	});

	it("refuses to act through a driver that cannot type, and says so", async () => {
		// The only fallback is running the command without a login
		// shell, which is the failure the capability exists to avoid, so
		// the honest answer is to hand back the recipe.
		clearTerminalDrivers();
		registerTerminalDriver({
			id: "mute",
			available: () => true,
			async spawn() {
				return {
					driverId: "mute",
					kind: "pane",
					hostId: "here",
					value: "1",
				};
			},
		});
		saveRecord(lostSession("sess-A", "QEST-1"));

		const result = succeeded(
			await handle(buildState(), fakePi(), fakeCtx(), {
				action: "restore",
				force: true,
			}),
		);
		expect(result.message).toContain("cannot type into a surface");
		expect(result.message).toContain("pi --session 'sess-A'");
	});

	it("lists rather than acts unless told to act", async () => {
		// Reopening a dozen tabs is too large a side effect to fire from
		// a verb the user may have run only to look.
		let spawns = 0;
		clearTerminalDrivers();
		registerTerminalDriver({
			id: "counting",
			available: () => true,
			async spawn() {
				spawns++;
				return undefined;
			},
		});
		saveRecord(lostSession("sess-A", "QEST-1"));
		await restoreNow();
		expect(spawns).toBe(0);
	});

	it("stops offering a session once it has been brought back", async () => {
		const state = buildState();
		const quest = await createQuest(state, "Recovered Quest");
		saveRecord(lostSession("sess-A", quest));
		expect((await restoreNow()).message).toContain("pi --session 'sess-A'");
		// Resuming the session is what a user does with the recipe. The
		// record rejoins the open set, and the offer has to stop.
		succeeded(
			await handle(state, fakePi(), fakeCtx("sess-A"), {
				action: "load",
				id: quest,
			}),
		);
		expect((await restoreNow()).message).toContain("nothing to restore");
	});
});
