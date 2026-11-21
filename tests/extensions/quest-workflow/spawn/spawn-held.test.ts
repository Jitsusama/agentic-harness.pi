import { describe, expect, it } from "vitest";
import {
	agentCommand,
	folderFor,
	heldWords,
	isThisMachine,
	joinLine,
	machineFor,
	type PlaceOnNode,
	type ShareQuest,
	type StartOnNode,
	spawnHeld,
	startNames,
} from "../../../../extensions/quest-workflow/verbs/spawn-held.ts";
import type { NodeStart } from "../../../../lib/mesh/node.ts";
import type { Need } from "../../../../lib/mesh/placement.ts";
import { fakeDriver } from "../../../lib/terminal/fakes.ts";

// The configured path points at a binary that exists on any POSIX
// machine, and the test process's own ancestry would contradict the
// fake's variables.
const opening = {
	platform: "linux",
	ancestry: false,
	settings: { drivers: { kitty: { path: "/bin/sh" } } },
	env: { KITTY_PANE: "1" },
} as const;

/** Sharing that always works, so no test reaches mycelium. */
const shares: ShareQuest = async () => ({ ok: true });

/** A node that answers each start with `answer`, keeping what it was asked. */
function node(answer: Awaited<ReturnType<StartOnNode>>) {
	const asked: NodeStart[] = [];
	const start: StartOnNode = async (one) => {
		asked.push(one);
		return answer;
	};
	return { asked, start };
}

const equilibrius = {
	ok: true,
	started: {
		machine: "equilibrius",
		held: "c97b4852",
		folder: "/Users/joel/src/core.nix",
		attach: [
			"ssh",
			"-t",
			"--",
			"equilibrius",
			"mycelium",
			"attach",
			"c97b4852",
		],
	},
} as const;

function asked(kitty: ReturnType<typeof fakeDriver>, dryRun = false) {
	return {
		machine: "equilibrius",
		needs: [],
		command: "pi",
		cwd: "/home/joel/src/core.nix",
		home: "/home/joel",
		questId: "QEST-20261013-4UHC5Q",
		layout: "tab",
		options: { ...opening, drivers: [kitty], dryRun },
	} as const;
}

describe("the folder a start names", () => {
	it("names a folder under home by its place within home on another machine", () => {
		expect(folderFor("/home/joel/src/core.nix", "/home/joel", false)).toBe(
			"src/core.nix",
		);
	});

	it("names nothing for a folder outside home, or home itself, on another machine", () => {
		expect(folderFor("/tmp/scratch", "/home/joel", false)).toBeUndefined();
		expect(folderFor("/home/joel", "/home/joel", false)).toBeUndefined();
		expect(folderFor("/home/joelle", "/home/joel", false)).toBeUndefined();
	});

	it("names this machine's own folder as it is", () => {
		expect(folderFor("/tmp/scratch", "/home/joel", true)).toBe("/tmp/scratch");
	});
});

describe("the command a spawn starts", () => {
	const agents = async () => new Map([["optimus", "pi-claude"]]);

	it("is the agent a machine's realm declares, fresh or resuming", async () => {
		// Joel's personal realm on optimus starts pi-claude, off the work mesh.
		expect(await agentCommand("pi", "optimus", agents)).toBe("pi-claude");
		expect(await agentCommand("pi --session s1", "optimus", agents)).toBe(
			"pi-claude --session s1",
		);
	});

	it("stays pi where nothing is declared, or no node answers", async () => {
		expect(await agentCommand("pi", "penelope", agents)).toBe("pi");
		expect(await agentCommand("pi", "optimus", async () => undefined)).toBe(
			"pi",
		);
		const plain = async () => new Map([["optimus", "pi"]]);
		expect(await agentCommand("pi", "optimus", plain)).toBe("pi");
	});

	it("leaves a command the call named alone", async () => {
		expect(await agentCommand("nvim", "optimus", agents)).toBe("nvim");
		expect(await agentCommand("pip install", "optimus", agents)).toBe(
			"pip install",
		);
	});
});

describe("the words a held spawn uses", () => {
	it("runs the command through sh with the quest to load in its environment", () => {
		expect(heldWords("pi --session 019a", "QEST-1")).toEqual([
			"env",
			"QUEST_WORKFLOW_AUTOLOAD_ID=QEST-1",
			"sh",
			"-c",
			"pi --session 019a",
		]);
	});

	it("names the sandbox a declared fence runs its commands in, and none otherwise", () => {
		expect(
			heldWords("pi", "QEST-1", undefined, undefined, "fence"),
			"a declared fence sets PI_SANDBOX and the mark that keeps it",
		).toEqual([
			"env",
			"QUEST_WORKFLOW_AUTOLOAD_ID=QEST-1",
			"PI_SANDBOX=fence",
			"PI_FENCE_DECLARED=1",
			"sh",
			"-c",
			"pi",
		]);
		expect(
			heldWords("pi", "QEST-1").join(" "),
			"no sandbox sets nothing",
		).not.toContain("PI_SANDBOX");
	});

	it("quotes each attach word so the shell runs them as given", () => {
		expect(joinLine(["ssh", "-t", "it's here"])).toBe(
			"'ssh' '-t' 'it'\\''s here'",
		);
	});

	it("knows this machine by its short name, as its node names it", () => {
		expect(
			isThisMachine("optimus", "optimus.local"),
			"a node named by its short name is this machine",
		).toBe(true);
		expect(
			isThisMachine("equilibrius", "optimus"),
			"another machine's name is not this one",
		).toBe(false);
	});
});

describe("spawning on a machine", () => {
	it("starts the session held there and opens no window here", async () => {
		const kitty = fakeDriver("kitty");
		const { asked: starts, start } = node(equilibrius);
		const outcome = await spawnHeld(asked(kitty), start, shares);
		expect(starts).toEqual([
			{
				machine: "equilibrius",
				needs: [],
				folder: "src/core.nix",
				command: heldWords("pi", "QEST-20261013-4UHC5Q"),
				once: expect.stringMatching(/^\S{1,64}$/),
			},
		]);
		expect(kitty.calls.spawned, "no window opened").toEqual([]);
		expect(kitty.calls.typed).toEqual([]);
		expect(outcome.ok && outcome.message).toContain(
			"Started a held session on equilibrius (equilibrius holds it as c97b4852, begun in /Users/joel/src/core.nix)",
		);
		expect(outcome.ok && outcome.details).toMatchObject({
			machine: "equilibrius",
			held: "c97b4852",
		});
	});

	it("tells the node the fence it declares, and starts it in that sandbox", async () => {
		const kitty = fakeDriver("kitty");
		const { asked: starts, start } = node(equilibrius);
		const fence = { kind: "fence", from: "quest" } as const;
		const outcome = await spawnHeld(
			{ ...asked(kitty), fence, sandbox: "fence" },
			start,
			shares,
		);
		expect(starts[0]?.fence, "the start declares the fence").toEqual(fence);
		expect(starts[0]?.command, "its commands run fenced").toContain(
			"PI_SANDBOX=fence",
		);
		expect(
			outcome.ok && outcome.details,
			"the details say the fence",
		).toMatchObject({ fence });
	});

	it("asks the node nothing and opens nothing on a dry run, saying what it would do", async () => {
		const kitty = fakeDriver("kitty");
		const { asked: starts, start } = node(equilibrius);
		const outcome = await spawnHeld(asked(kitty, true), start, shares);
		expect(starts).toEqual([]);
		expect(kitty.calls.spawned).toEqual([]);
		expect(outcome).toMatchObject({ ok: true, planned: true });
		expect(outcome.ok && outcome.message).toContain(
			"ask equilibrius's mycelium node to start a held session in src/core.nix, running: pi",
		);
	});

	it("says the node's reason and opens nothing when nothing starts", async () => {
		const kitty = fakeDriver("kitty");
		const { start } = node({
			ok: false,
			reason: "no link reaches equilibrius now",
		});
		const outcome = await spawnHeld(asked(kitty), start, shares);
		expect(outcome).toEqual({
			ok: false,
			refusal:
				"Nothing was started on equilibrius: no link reaches equilibrius now.",
		});
		expect(kitty.calls.spawned).toEqual([]);
	});

	it("names what the node chose the machine for, and starts with those needs", async () => {
		const kitty = fakeDriver("kitty");
		const { asked: starts, start } = node(equilibrius);
		const home: Need = { kind: "reach", value: "home" };
		const outcome = await spawnHeld(
			{ ...asked(kitty), needs: [home] },
			start,
			shares,
		);
		expect(starts[0]?.needs).toEqual([home]);
		expect(outcome.ok && outcome.message).toContain(
			"The node chose equilibrius for reach=home. Started a held session",
		);
	});
});

// KP0L6A (19 Nov): a start the node answered after 45 s still landed, and
// the agent's retry started a second session.
describe("a start asked again after the node answered nothing", () => {
	const silent = {
		ok: false,
		reason: "the node took the ask and answered nothing within 120 s",
		mayLand: true,
	} as const;

	/** A node answering each start in turn with `answers`, keeping each. */
	function answering(...answers: Awaited<ReturnType<StartOnNode>>[]) {
		const asked: NodeStart[] = [];
		const start: StartOnNode = async (one) => {
			asked.push(one);
			return answers.shift() ?? equilibrius;
		};
		return { asked, start };
	}

	it("asks again under the name of the start that may still land, and says so", async () => {
		const kitty = fakeDriver("kitty");
		const names = startNames();
		const { asked: starts, start } = answering(silent, equilibrius);
		const first = await spawnHeld(
			{ ...asked(kitty), firstWords: "01JFIRST" },
			start,
			shares,
			names,
		);
		expect(first.ok || first.refusal).toContain(
			"It may still start there, so look for it there before spawning it again.",
		);
		const again = await spawnHeld(
			{ ...asked(kitty), firstWords: "01JAGAIN" },
			start,
			shares,
			names,
		);
		expect(again.ok, "asked again, it is the start that landed").toBe(true);
		expect(starts[0]?.once).toMatch(/^\S{1,64}$/);
		expect(starts[1]?.once).toBe(starts[0]?.once);
	});

	it("names each start afresh once the node answered the one before", async () => {
		const kitty = fakeDriver("kitty");
		const names = startNames();
		const { asked: starts, start } = answering(
			{ ok: false, reason: "no link reaches equilibrius now" },
			equilibrius,
			equilibrius,
		);
		for (let one = 0; one < 3; one++) {
			await spawnHeld(asked(kitty), start, shares, names);
		}
		const once = new Set(starts.map((one) => one.once));
		expect(once.size, "a start answered, even refused, is never joined").toBe(
			3,
		);
	});

	it("names afresh a start of something else, or one asked ten minutes on", async () => {
		const kitty = fakeDriver("kitty");
		let now = 0;
		const names = startNames(() => now);
		const { asked: starts, start } = answering(silent, silent, silent);
		await spawnHeld(asked(kitty), start, shares, names);
		await spawnHeld(
			{ ...asked(kitty), command: "pi --model other" },
			start,
			shares,
			names,
		);
		await spawnHeld(
			{ ...asked(kitty), machine: "penelope" },
			start,
			shares,
			names,
		);
		await spawnHeld(
			{ ...asked(kitty), cwd: "/home/joel/src/other" },
			start,
			shares,
			names,
		);
		now = 10 * 60_000;
		await spawnHeld(asked(kitty), start, shares, names);
		const once = new Set(starts.map((one) => one.once));
		expect(once.size, "each a start of its own").toBe(5);
	});

	it("names afresh a start just like one still being asked", async () => {
		const kitty = fakeDriver("kitty");
		const names = startNames();
		const asked1: NodeStart[] = [];
		let answer: (() => void) | undefined;
		const start: StartOnNode = async (one) => {
			asked1.push(one);
			if (asked1.length === 1) {
				await new Promise<void>((answered) => {
					answer = answered;
				});
			}
			return equilibrius;
		};
		const first = spawnHeld(asked(kitty), start, shares, names);
		await spawnHeld(asked(kitty), start, shares, names);
		answer?.();
		await first;
		expect(asked1).toHaveLength(2);
		expect(asked1[1]?.once, "two spawns at once are two starts").not.toBe(
			asked1[0]?.once,
		);
	});
});

describe("the machine a spawn starts on", () => {
	/** A node placing everything on `answer`, keeping what it was asked. */
	function placing(answer: Awaited<ReturnType<PlaceOnNode>>) {
		const asked: (readonly Need[])[] = [];
		const place: PlaceOnNode = async (needs) => {
			asked.push(needs);
			return answer;
		};
		return { asked, place };
	}

	it("is the one asked, with the node not asked, when nothing more is needed", async () => {
		const { asked, place } = placing({ ok: true, machine: "optimus" });
		expect(await machineFor("equilibrius", [], place)).toEqual({
			ok: true,
			machine: "equilibrius",
			needs: [],
		});
		expect(await machineFor(undefined, [], place)).toEqual({
			ok: true,
			machine: undefined,
			needs: [],
		});
		expect(asked).toEqual([]);
	});

	it("is where the node places what is needed, the machine asked among it", async () => {
		const { asked, place } = placing({ ok: true, machine: "equilibrius" });
		const chosen = await machineFor("equilibrius", ["system=macos"], place);
		expect(chosen).toEqual({
			ok: true,
			machine: "equilibrius",
			needs: [{ kind: "system", value: "macos" }],
		});
		expect(asked).toEqual([
			[
				{ kind: "system", value: "macos" },
				{ kind: "machine", value: "equilibrius" },
			],
		]);
	});

	it("tells the node the fence it declares, whatever is needed", async () => {
		const fences: unknown[] = [];
		const place: PlaceOnNode = async (_needs, fence) => {
			fences.push(fence);
			return { ok: true, machine: "optimus" };
		};
		const fence = { kind: "strict", from: "spawn" } as const;
		await machineFor(undefined, ["reach=home"], place, fence);
		expect(fences, "the place asked carries the fence").toEqual([fence]);
	});

	it("refuses with the node's reasons, or the words that aren't a need", async () => {
		const { asked, place } = placing({
			ok: false,
			reason: "no machine takes it: optimus lacks reach=home",
		});
		expect(await machineFor(undefined, ["reach=home"], place)).toEqual({
			ok: false,
			refusal:
				"Nothing was started, since mycelium's node placed it nowhere: no machine takes it: optimus lacks reach=home.",
		});
		const bad = await machineFor(undefined, ["home"], place);
		expect(!bad.ok && bad.refusal).toContain('"home" is not a need');
		const torn = await machineFor("optimus", ["machine=equilibrius"], place);
		expect(!torn.ok && torn.refusal).toBe(
			"machine names optimus but needs names machine=equilibrius, and a session starts on one machine; name it once.",
		);
		expect(asked).toHaveLength(1);
	});
});
