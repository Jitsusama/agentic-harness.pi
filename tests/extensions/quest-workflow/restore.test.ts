import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readRecord,
	reopenLostSessions,
	saveRecord,
} from "../../../extensions/quest-workflow/session-registry";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { restore } from "../../../extensions/quest-workflow/verbs/queries";
import {
	closeRecord,
	openRecord,
	reopenRecord,
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

/**
 * A record for a session lost with the machine it ran on, half an hour
 * ago, which is well inside the retention restore prunes to.
 */
function lostSession(sessionId: string, questId: string) {
	const at = new Date(Date.now() - 30 * 60_000);
	return closeRecord(
		openRecord({
			sessionId,
			instanceId: "inst-gone",
			cwd: tmpRoot,
			questId,
			// It ran in the boot before this one, as a power-off leaves it:
			// restore offers only what the last boot's end took away.
			process: {
				hostId: hostname(),
				pid: 4242,
				startToken: "Tue Oct 28 20:40:00 2026",
				bootToken: "the-boot-before",
			},
			now: new Date(at.getTime() - 30 * 60_000),
		}),
		"died",
		at,
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

/**
 * What a pi does when a resume line reaches a shell: start, and put its
 * session's record back in the open set. Restore waits for exactly
 * that before it calls a session reopened.
 */
function checkIn(line: string | undefined): void {
	// A fresh pi records a session of its own on the quest it was given.
	const quest = /QUEST_WORKFLOW_AUTOLOAD_ID='([^']+)' pi$/m.exec(
		line ?? "",
	)?.[1];
	if (quest) {
		saveRecord(
			openRecord({
				sessionId: "sess-fresh",
				instanceId: "inst-fresh",
				cwd: tmpRoot,
				questId: quest,
				now: new Date(),
			}),
		);
		return;
	}
	const id = /pi --session '([^']+)'/.exec(line ?? "")?.[1];
	const record = id ? readRecord(id) : undefined;
	if (record) saveRecord(reopenRecord(record, { instanceId: "inst-back" }));
}

/** pi's session store, holding a saved log for each of `ids`. */
function savedSessions(...ids: string[]): void {
	const dir = join(tmpRoot, ".pi", "agent", "sessions", "--work--");
	mkdirSync(dir, { recursive: true });
	for (const id of ids) {
		writeFileSync(join(dir, `2026-10-24T02-51-00-000Z_${id}.jsonl`), "{}\n");
	}
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
			checkIn(text);
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

	it("lists a window joined to another machine's session with the words that rejoin it", async () => {
		// The note the timer wrote in the boot that ended, read in this one
		// before this boot has written its own.
		const stateDir = join(
			process.env.XDG_STATE_HOME ?? "",
			"pi",
			"agentic-harness.pi",
			"quest-workflow",
		);
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "windows-elsewhere.json"),
			JSON.stringify({
				v: 1,
				boot: "a-boot-that-has-since-ended",
				windows: [
					{
						id: "01a19000-mac1",
						address: "SAK9FZ",
						title: "Steer Across Machines",
						quest: "QEST-20261029-SAK9FZ",
						machine: "equilibrius",
						attach: [
							"ssh",
							"-t",
							"equilibrius",
							"mycelium",
							"attach",
							"9f2c1a07",
						],
						cwd: "/home/me",
					},
				],
			}),
		);

		const result = await restoreNow();

		expect(result.message).toContain("No session here was running");
		expect(result.message).toContain(
			"QEST-20261029-SAK9FZ on equilibrius: ssh -t equilibrius mycelium attach 9f2c1a07",
		);
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
				checkIn(text);
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

	it("hands the line to a driver that cannot type, and says what that costs", async () => {
		// A driver that cannot type can still be handed the command; it
		// runs without the person's startup files, and the answer says so
		// rather than leaving them to find out.
		const handed: (string | undefined)[] = [];
		clearTerminalDrivers();
		registerTerminalDriver({
			id: "mute",
			available: () => true,
			async spawn(request) {
				handed.push(request.command);
				checkIn(request.command);
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
		expect(handed).toEqual(["pi --session 'sess-A'"]);
		expect(result.message).toContain("Reopened 1 of 1");
		expect(result.message).toContain("without your startup files");
	});

	it("says which sessions opened but never checked in", async () => {
		// A command sent is not a session restored: one whose pi has not
		// started by the end of the wait is reported apart.
		clearTerminalDrivers();
		registerTerminalDriver({
			id: "silent",
			available: () => true,
			async spawn() {
				return { driverId: "silent", kind: "pane", hostId: "here", value: "1" };
			},
			async typeInto() {},
		} as TerminalDriver & TerminalTypeCapability);
		const record = lostSession("sess-A", "QEST-1");
		saveRecord(record);
		const outcome = await reopenLostSessions([record], { confirmMs: 300 });
		expect(outcome.reopened).toEqual([]);
		expect(outcome.unconfirmed).toEqual(["sess-A"]);
	});

	it("says how force would open the sessions when it only lists them", async () => {
		recordingDriver();
		saveRecord(lostSession("sess-A", "QEST-1"));
		const { message } = await restoreNow();
		expect(message).toContain(
			"force would open them through recording, attached",
		);
	});

	it("opens them in the layout the call names", async () => {
		const layouts: string[] = [];
		clearTerminalDrivers();
		registerTerminalDriver({
			id: "layouts",
			available: () => true,
			async spawn(request) {
				layouts.push(request.layout);
				return {
					driverId: "layouts",
					kind: "pane",
					hostId: "here",
					value: "1",
				};
			},
			async typeInto(_handle: TerminalSessionHandle, text: string) {
				checkIn(text);
			},
		} as TerminalDriver & TerminalTypeCapability);
		saveRecord(lostSession("sess-A", "QEST-1"));
		saveRecord(lostSession("sess-B", "QEST-2"));
		succeeded(
			await handle(buildState(), fakePi(), fakeCtx(), {
				action: "restore",
				force: true,
				layout: "window",
			}),
		);
		expect(layouts).toEqual(["window", "window"]);
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

	describe("a lost session pi never saved", () => {
		// pi saves a session with its first message. One lost before then
		// has nothing to resume: `pi --session` says it found no session
		// and exits, and restore used to call that opened but unconfirmed.
		it("is offered as a fresh start on its quest", async () => {
			savedSessions("sess-saved");
			saveRecord(lostSession("sess-saved", "QEST-1"));
			saveRecord(lostSession("sess-new", "QEST-2"));
			const { message } = await restoreNow();
			expect(message).toContain("pi --session 'sess-saved'");
			expect(message).not.toContain("pi --session 'sess-new'");
			expect(message).toContain(
				`(cd '${tmpRoot}' && QUEST_WORKFLOW_AUTOLOAD_ID='QEST-2' pi)  # QEST-2`,
			);
			expect(message).toMatch(
				/QEST-2 .*sess-new.*pi never saved it, so it starts fresh on its quest/,
			);
		});

		it("is started fresh on its quest when forced, and said so", async () => {
			savedSessions("sess-other");
			const typed = recordingDriver();
			saveRecord(lostSession("sess-new", "QEST-2"));
			const result = succeeded(
				await handle(buildState(), fakePi(), fakeCtx(), {
					action: "restore",
					force: true,
				}),
			);
			expect(typed.map((t) => t.text)).toEqual([
				"QUEST_WORKFLOW_AUTOLOAD_ID='QEST-2' pi\n",
			]);
			expect(result.message).toContain("Reopened 1 of 1");
			expect(result.message).toContain(
				"Started fresh on their quests, since pi never saved them:",
			);
			expect(result.message).toContain("- sess-new: QEST-2");
			expect(result.message).not.toContain("not yet seen running");
			expect((await restoreNow()).message).toContain("nothing to restore");
		});

		it("stops being offered once a session is started in its place", async () => {
			savedSessions("sess-other");
			saveRecord(lostSession("sess-new", "QEST-2"));
			checkIn("QUEST_WORKFLOW_AUTOLOAD_ID='QEST-2' pi");
			expect((await restoreNow()).message).toContain("nothing to restore");
		});

		it("is resumed as before when pi's store cannot be read", async () => {
			// No store means no way to tell, and starting a saved session
			// afresh would lose it, so the resume line stands.
			saveRecord(lostSession("sess-new", "QEST-2"));
			expect((await restoreNow()).message).toContain("pi --session 'sess-new'");
		});
	});

	it("stops offering a session once it has been brought back", async () => {
		const state = buildState();
		const quest = await createQuest(state, "Recovered Quest");
		saveRecord(lostSession("sess-A", quest));
		expect((await restoreNow()).message).toContain("pi --session 'sess-A'");
		// Resuming the session is what a user does with the recipe. The
		// record rejoins the open set, and the offer has to stop. Only a
		// tab a person sits in is tracked, so the context has a UI.
		const resumed = {
			...(fakeCtx("sess-A") as object),
			hasUI: true,
		} as unknown as Parameters<typeof handle>[2];
		succeeded(
			await handle(state, fakePi(), resumed, {
				action: "load",
				id: quest,
			}),
		);
		expect((await restoreNow()).message).toContain("nothing to restore");
	});
});

describe("restore through the desktop's launcher", () => {
	/**
	 * A launcher that takes what it's handed and, as its own reopening
	 * does, starts each pi, or answers `answer` and starts nothing.
	 */
	function launcher(answer = "taken") {
		const handed: { id: string; cwd: string }[][] = [];
		const call = async (argument: string) => {
			const { sessions } = JSON.parse(argument) as {
				sessions: { id: string; cwd: string }[];
			};
			handed.push(sessions);
			if (answer === "taken") {
				for (const one of sessions) checkIn(`pi --session '${one.id}'`);
			}
			return answer;
		};
		return { handed, call };
	}

	it("hands the saved sessions to the launcher, which puts each where it sat", async () => {
		const typed = recordingDriver();
		const shell = launcher();
		savedSessions("sess-A", "sess-B");
		saveRecord(lostSession("sess-A", "QEST-1"));
		saveRecord(lostSession("sess-B", "QEST-2"));
		const { message } = succeeded(
			await restore(buildState(), { act: true, launcher: shell.call }),
		);
		expect(shell.handed).toHaveLength(1);
		expect(shell.handed[0]?.map((one) => one.id).sort()).toEqual([
			"sess-A",
			"sess-B",
		]);
		expect(shell.handed[0]?.[0]?.cwd).toBe(tmpRoot);
		expect(typed).toEqual([]);
		expect(message).toContain(
			"Reopened 2 of 2 sessions, through the launcher, each where it sat.",
		);
	});

	it("opens them itself, paced, when the launcher refuses them", async () => {
		const typed = recordingDriver();
		const shell = launcher("refused: no session with an id and a folder");
		savedSessions("sess-A");
		saveRecord(lostSession("sess-A", "QEST-1"));
		const { message } = succeeded(
			await restore(buildState(), { act: true, launcher: shell.call }),
		);
		expect(shell.handed).toHaveLength(1);
		expect(typed.map((t) => t.text)).toEqual(["pi --session 'sess-A'\n"]);
		expect(message).toContain("Reopened 1 of 1 session, through recording");
	});

	it("starts a session pi never saved itself, since the launcher only resumes", async () => {
		const typed = recordingDriver();
		const shell = launcher();
		savedSessions("sess-A");
		saveRecord(lostSession("sess-A", "QEST-1"));
		saveRecord(lostSession("sess-new", "QEST-2"));
		const { message } = succeeded(
			await restore(buildState(), { act: true, launcher: shell.call }),
		);
		expect(shell.handed.flat().map((one) => one.id)).toEqual(["sess-A"]);
		expect(typed.map((t) => t.text)).toEqual([
			"QUEST_WORKFLOW_AUTOLOAD_ID='QEST-2' pi\n",
		]);
		expect(message).toContain(
			"through the launcher, each where it sat, and recording",
		);
	});

	it("leaves the launcher out when the call names how to open them", async () => {
		const typed = recordingDriver();
		const shell = launcher();
		savedSessions("sess-A");
		saveRecord(lostSession("sess-A", "QEST-1"));
		succeeded(
			await restore(buildState(), {
				act: true,
				layout: "window",
				launcher: shell.call,
			}),
		);
		expect(shell.handed).toEqual([]);
		expect(typed).toHaveLength(1);
	});

	it("hands nothing over when it only lists them, and says it would", async () => {
		recordingDriver();
		const shell = launcher();
		savedSessions("sess-A");
		saveRecord(lostSession("sess-A", "QEST-1"));
		const { message } = succeeded(
			await restore(buildState(), { launcher: shell.call }),
		);
		expect(shell.handed).toEqual([]);
		expect(message).toContain(
			"First it would hand those pi saved to the launcher",
		);
	});
});
