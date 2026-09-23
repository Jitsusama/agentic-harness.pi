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
import { createEnvGuard, refused, succeeded } from "./_helpers";

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

/** A record for a session its user quit a moment ago. */
function quitSession(sessionId: string, questId: string, minutesAgo = 5) {
	const at = new Date(Date.now() - minutesAgo * 60_000);
	return closeRecord(
		openRecord({
			sessionId,
			instanceId: "inst-quit",
			cwd: tmpRoot,
			questId,
			now: new Date(at.getTime() - 60_000),
		}),
		"quit",
		at,
	);
}

/** A terminal driver that records what restore typed, and where. */
function recordingDriver(): { pane: string; text: string }[] {
	const typed: { pane: string; text: string }[] = [];
	let next = 0;
	clearTerminalDrivers();
	registerTerminalDriver({
		id: "recording",
		available: () => true,
		async spawn() {
			next++;
			return {
				driverId: "recording",
				kind: "pane",
				hostId: "here",
				value: String(next),
			};
		},
		async typeInto(handle: TerminalSessionHandle, text: string) {
			typed.push({ pane: handle.value, text });
		},
	} as TerminalDriver & TerminalTypeCapability);
	return typed;
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
		expect(typed).toEqual([{ pane: "7", text: "pi --session 'sess-A'\n" }]);
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

	it("refuses to open an unreasonable number of terminals at once", async () => {
		// A registry that has gone wrong, or a machine left off for a
		// month, should not be able to turn one verb into fifty windows
		// appearing. Refusing whole is kinder than stopping halfway.
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
		for (let i = 0; i < 25; i++) {
			saveRecord(lostSession(`sess-${i}`, "QEST-1"));
		}
		const result = succeeded(
			await handle(buildState(), fakePi(), fakeCtx(), {
				action: "restore",
				force: true,
			}),
		);
		expect(spawns).toBe(0);
		expect(result.message).toContain("25");
		// The recipe is still there, so the user is not stuck.
		expect(result.message).toContain("pi --session 'sess-0'");
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

	it("lists sessions closed in the last day below the lost ones", async () => {
		// pi calls some signals a quit, so a tab taken away can land with
		// the deliberate closes. Listing the recent ones is the backstop.
		saveRecord(lostSession("sess-lost", "QEST-1"));
		saveRecord(quitSession("sess-quit", "QEST-2"));
		const { message } = await restoreNow();
		const closedAt = message.indexOf("Closed in the last day");
		expect(closedAt).toBeGreaterThan(message.indexOf("sess-lost"));
		expect(message.indexOf("pi --session 'sess-quit'")).toBeGreaterThan(
			closedAt,
		);
	});

	it("lists recently closed sessions even when nothing was lost", async () => {
		saveRecord(quitSession("sess-quit", "QEST-2"));
		const { message } = await restoreNow();
		expect(message).toContain("nothing to restore");
		expect(message).toContain("pi --session 'sess-quit'");
	});

	it("leaves out a session closed more than a day ago", async () => {
		saveRecord(quitSession("sess-old", "QEST-2", 25 * 60));
		expect((await restoreNow()).message).not.toContain("sess-old");
	});

	it("shows the ten most recent closes and says how many it left out", async () => {
		for (let i = 0; i < 12; i++) {
			saveRecord(quitSession(`sess-q${i}`, "QEST-2", i + 1));
		}
		const { message } = await restoreNow();
		expect(message).toContain("sess-q9'");
		expect(message).not.toContain("sess-q10'");
		expect(message).toContain("2 more");
	});

	it("reopens only the lost sessions when forced", async () => {
		const typed = recordingDriver();
		saveRecord(lostSession("sess-lost", "QEST-1"));
		saveRecord(quitSession("sess-quit", "QEST-2"));
		succeeded(
			await handle(buildState(), fakePi(), fakeCtx(), {
				action: "restore",
				force: true,
			}),
		);
		expect(typed.map((t) => t.text)).toEqual(["pi --session 'sess-lost'\n"]);
	});

	describe("naming sessions with id", () => {
		async function restoreIds(id: string, force = false) {
			return handle(buildState(), fakePi(), fakeCtx(), {
				action: "restore",
				id,
				force,
			});
		}

		it("reopens a recently closed session it was asked for", async () => {
			// The backstop is only useful if bringing one back is a single
			// call rather than a line to copy into a new tab by hand.
			const typed = recordingDriver();
			saveRecord(lostSession("sess-lost", "QEST-1"));
			saveRecord(quitSession("sess-quit", "QEST-2"));
			const result = succeeded(await restoreIds("sess-quit", true));
			expect(typed.map((t) => t.text)).toEqual(["pi --session 'sess-quit'\n"]);
			expect(result.message).toContain("Reopened 1 of 1");
		});

		it("takes several, by the front of each id", async () => {
			const typed = recordingDriver();
			saveRecord(lostSession("01aaa-lost", "QEST-1"));
			saveRecord(quitSession("01bbb-quit", "QEST-2"));
			saveRecord(quitSession("01ccc-quit", "QEST-3"));
			succeeded(await restoreIds("01aaa, 01ccc", true));
			expect(typed.map((t) => t.text).sort()).toEqual([
				"pi --session '01aaa-lost'\n",
				"pi --session '01ccc-quit'\n",
			]);
		});

		it("lists only the named sessions without force", async () => {
			saveRecord(lostSession("sess-lost", "QEST-1"));
			saveRecord(quitSession("sess-quit", "QEST-2"));
			const { message } = succeeded(await restoreIds("sess-quit"));
			expect(message).toContain("pi --session 'sess-quit'");
			expect(message).not.toContain("sess-lost");
		});

		it("refuses a name that matches no session it would list", async () => {
			saveRecord(quitSession("sess-quit", "QEST-2"));
			expect(refused(await restoreIds("sess-nope", true)).guidance).toContain(
				"sess-nope",
			);
		});

		it("refuses a name that could mean more than one session", async () => {
			// Guessing which tab to open is worse than asking, since the
			// wrong guess spawns a terminal.
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
			saveRecord(quitSession("sess-quit-1", "QEST-2"));
			saveRecord(quitSession("sess-quit-2", "QEST-3"));
			const result = refused(await restoreIds("sess-quit", true));
			expect(result.guidance).toContain("sess-quit-1");
			expect(result.guidance).toContain("sess-quit-2");
			expect(spawns).toBe(0);
		});
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
