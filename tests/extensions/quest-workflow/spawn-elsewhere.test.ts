/**
 * A spawn starts where mycelium's node places it, not always here: Joel
 * asked on 15 November why 115 sessions ran on optimus and 3 on the work
 * Mac when the node would pick the Mac (WCJQSG [66388615]). One started
 * on another machine has its quest shared there first, is told its first
 * words in the start itself, and opens no window on his screen unless
 * the call asks for one (WM4KSZ [a124c9cb]).
 */
import { hostname } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
	heldWords,
	machineByDefault,
	type PlaceOnNode,
	type ShareQuest,
	type StartOnNode,
	spawnHeld,
} from "../../../extensions/quest-workflow/verbs/spawn-held.ts";
import { launchHints } from "../../../lib/core/session/index.ts";
import { FIRST_TEXT_VARIABLE } from "../../../lib/internal/quest/first-words.ts";
import type { Need } from "../../../lib/mesh/placement.ts";
import { fakeDriver } from "../../lib/terminal/fakes.ts";

// The configured path points at a binary that exists on any POSIX
// machine, and the test process's own ancestry would contradict the
// fake's variables.
const opening = {
	platform: "linux",
	ancestry: false,
	settings: { drivers: { kitty: { path: "/bin/sh" } } },
	env: { KITTY_PANE: "1" },
} as const;

/** A node that places everything on `machine`, keeping what it was asked. */
function placing(machine: string | undefined) {
	const asked: (readonly Need[])[] = [];
	const place: PlaceOnNode = async (needs) => {
		asked.push(needs);
		return machine === undefined
			? { ok: false, reason: "no mycelium node answered" }
			: { ok: true, machine };
	};
	return { asked, place };
}

const plain = { resumes: false };

describe("the machine a spawn starts on by default", () => {
	it("is where the node places work needing nothing, when that is another machine", async () => {
		const { asked, place } = placing("equilibrius");
		expect(await machineByDefault(undefined, [], plain, place, "optimus")).toBe(
			"equilibrius",
		);
		expect(asked, "the node is asked with no needs").toEqual([[]]);
	});

	it("is here when the node places it here or doesn't answer", async () => {
		expect(
			await machineByDefault(
				undefined,
				[],
				plain,
				placing("optimus").place,
				"optimus",
			),
			"placed here starts as a spawn always has",
		).toBeUndefined();
		expect(
			await machineByDefault(
				undefined,
				[],
				plain,
				placing(undefined).place,
				"optimus",
			),
			"no node starts here rather than failing",
		).toBeUndefined();
	});

	it("asks nothing when a session resumes here, a host or a command is named", async () => {
		const { asked, place } = placing("equilibrius");
		for (const ask of [
			{ resumes: true },
			{ resumes: false, host: "attended" },
			{ resumes: false, command: "nvim" },
		]) {
			expect(
				await machineByDefault(undefined, [], ask, place, "optimus"),
			).toBeUndefined();
		}
		expect(asked, "the node was never asked").toEqual([]);
	});

	it("keeps the machine a call or the quest's needs already chose", async () => {
		const { asked, place } = placing("equilibrius");
		expect(await machineByDefault("optimus", [], plain, place, "optimus")).toBe(
			"optimus",
		);
		const linux: Need = { kind: "system", value: "linux" };
		expect(
			await machineByDefault(undefined, [linux], plain, place, "optimus"),
			"needs already asked the node; nothing chose another machine",
		).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it("asks the node again for each spawn of a burst, following each answer", async () => {
		const answers = ["equilibrius", "optimus", "penelope"];
		let asks = 0;
		const place: PlaceOnNode = async () => ({
			ok: true,
			machine: answers[asks++ % answers.length] ?? "optimus",
		});
		const chosen: (string | undefined)[] = [];
		for (let n = 0; n < 10; n++) {
			chosen.push(
				await machineByDefault(undefined, [], plain, place, "optimus"),
			);
		}
		expect(asks, "one ask a spawn, none remembered").toBe(10);
		expect(chosen.slice(0, 3)).toEqual(["equilibrius", undefined, "penelope"]);
	});
});

/** A node that starts everything on equilibrius, keeping what it ran. */
function node() {
	const commands: (readonly string[])[] = [];
	const start: StartOnNode = async (one) => {
		commands.push(one.command);
		return {
			ok: true,
			started: {
				machine: one.machine,
				held: "c97b4852",
				folder: "/Users/joel/src/core.nix",
				attach: [
					"ssh",
					"-t",
					"--",
					one.machine,
					"mycelium",
					"attach",
					"c97b4852",
				],
			},
		};
	};
	return { commands, start };
}

/** Sharing that answers `answer`, keeping each quest it shared. */
function sharing(answer: Awaited<ReturnType<ShareQuest>> = { ok: true }) {
	const shared: string[] = [];
	const share: ShareQuest = async (questId) => {
		shared.push(questId);
		return answer;
	};
	return { shared, share };
}

function spawnOn(
	machine: string,
	kitty: ReturnType<typeof fakeDriver>,
	more: { firstText?: string; dryRun?: boolean } = {},
) {
	return {
		machine,
		needs: [],
		command: "pi",
		cwd: "/home/joel/src/core.nix",
		home: "/home/joel",
		questId: "QEST-20261013-4UHC5Q",
		layout: "tab",
		...(more.firstText !== undefined ? { firstText: more.firstText } : {}),
		options: { ...opening, drivers: [kitty], dryRun: more.dryRun ?? false },
	} as const;
}

describe("a spawn on another machine", () => {
	it("shares the quest there before it starts", async () => {
		const kitty = fakeDriver("kitty");
		const { start } = node();
		const { shared, share } = sharing();
		const outcome = await spawnHeld(
			spawnOn("equilibrius", kitty),
			start,
			share,
		);
		expect(shared).toEqual(["QEST-20261013-4UHC5Q"]);
		expect(outcome.ok, "it started").toBe(true);
	});

	it("still starts when sharing fails, and says why", async () => {
		const kitty = fakeDriver("kitty");
		const { commands, start } = node();
		const { share } = sharing({ ok: false, reason: "no link reaches it" });
		const outcome = await spawnHeld(
			spawnOn("equilibrius", kitty),
			start,
			share,
		);
		expect(commands, "the session was started anyway").toHaveLength(1);
		expect(outcome.ok && outcome.message).toContain(
			"Its quest wasn't shared there (no link reaches it)",
		);
	});

	it("carries its first words in the start, since a file here names nothing there", async () => {
		const kitty = fakeDriver("kitty");
		const { commands, start } = node();
		await spawnHeld(
			spawnOn("equilibrius", kitty, { firstText: "Carry on with QEST-1." }),
			start,
			sharing().share,
		);
		expect(commands[0]).toContain(
			`${FIRST_TEXT_VARIABLE}=Carry on with QEST-1.`,
		);
	});

	it("opens no window, though a tab was asked, and says how to join it", async () => {
		const kitty = fakeDriver("kitty");
		const outcome = await spawnHeld(
			spawnOn("equilibrius", kitty),
			node().start,
			sharing().share,
		);
		expect(kitty.calls.spawned, "no window opened").toEqual([]);
		expect(kitty.calls.typed).toEqual([]);
		expect(outcome.ok && outcome.message).toContain(
			"No window was opened; join it with: 'ssh' '-t' '--' 'equilibrius' 'mycelium' 'attach' 'c97b4852'",
		);
	});

	it("shares nothing and starts nothing on a dry run, saying it would share", async () => {
		const kitty = fakeDriver("kitty");
		const { commands, start } = node();
		const { shared, share } = sharing();
		const outcome = await spawnHeld(
			spawnOn("equilibrius", kitty, { dryRun: true }),
			start,
			share,
		);
		expect(shared).toEqual([]);
		expect(commands).toEqual([]);
		expect(outcome.ok && outcome.message).toContain(
			"share QEST-20261013-4UHC5Q",
		);
	});
});

describe("a held spawn on this machine", () => {
	it("shares nothing and opens its window as before", async () => {
		const kitty = fakeDriver("kitty");
		const { shared, share } = sharing();
		const here = hostname().split(".")[0] ?? "";
		await spawnHeld(spawnOn(here, kitty), node().start, share);
		expect(shared).toEqual([]);
		expect(kitty.calls.typed, "a window opened here").toHaveLength(1);
	});
});

describe("a session started with its first words", () => {
	it("takes them from its environment once, as words to say", () => {
		vi.stubEnv(FIRST_TEXT_VARIABLE, "Carry on with QEST-1.");
		expect(launchHints().firstWords).toBe("Carry on with QEST-1.");
		expect(
			process.env[FIRST_TEXT_VARIABLE],
			"taken, so a pi it starts isn't told them too",
		).toBeUndefined();
		vi.unstubAllEnvs();
	});
});

describe("the words a held spawn runs", () => {
	it("say the first words themselves when given, after the quest", () => {
		expect(heldWords("pi", "QEST-1", undefined, "Go on.")).toEqual([
			"env",
			"QUEST_WORKFLOW_AUTOLOAD_ID=QEST-1",
			`${FIRST_TEXT_VARIABLE}=Go on.`,
			"sh",
			"-c",
			"pi",
		]);
	});
});
