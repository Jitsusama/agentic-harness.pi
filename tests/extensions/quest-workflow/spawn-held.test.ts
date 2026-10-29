import { describe, expect, it } from "vitest";
import {
	folderFor,
	heldWords,
	isThisMachine,
	joinLine,
	machineFor,
	type PlaceOnNode,
	type StartOnNode,
	spawnHeld,
} from "../../../extensions/quest-workflow/verbs/spawn-held.ts";
import type { NodeStart } from "../../../lib/mesh/node.ts";
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

	it("quotes each attach word so the shell runs them as given", () => {
		expect(joinLine(["ssh", "-t", "it's here"])).toBe(
			"'ssh' '-t' 'it'\\''s here'",
		);
	});

	it("knows this machine by its short name, as its node names it", () => {
		expect(isThisMachine("optimus", "optimus.local")).toBe(true);
		expect(isThisMachine("equilibrius", "optimus")).toBe(false);
	});
});

describe("spawning on a machine", () => {
	it("starts the session held there and opens a window here on its attach words", async () => {
		const kitty = fakeDriver("kitty");
		const { asked: starts, start } = node(equilibrius);
		const outcome = await spawnHeld(asked(kitty), start);
		expect(starts).toEqual([
			{
				machine: "equilibrius",
				needs: [],
				folder: "src/core.nix",
				command: heldWords("pi", "QEST-20261013-4UHC5Q"),
			},
		]);
		expect(kitty.calls.typed.map((typed) => typed.text)).toEqual([
			"'ssh' '-t' '--' 'equilibrius' 'mycelium' 'attach' 'c97b4852'\n",
		]);
		expect(outcome.ok && outcome.message).toContain(
			"Started a held session on equilibrius (equilibrius holds it as c97b4852, begun in /Users/joel/src/core.nix)",
		);
		expect(outcome.ok && outcome.details).toMatchObject({
			machine: "equilibrius",
			held: "c97b4852",
		});
	});

	it("asks the node nothing and opens nothing on a dry run, saying what it would do", async () => {
		const kitty = fakeDriver("kitty");
		const { asked: starts, start } = node(equilibrius);
		const outcome = await spawnHeld(asked(kitty, true), start);
		expect(starts).toEqual([]);
		expect(kitty.calls.spawned).toEqual([]);
		expect(outcome.ok && outcome.planned).toBe(true);
		expect(outcome.ok && outcome.message).toContain(
			"Would ask equilibrius's mycelium node to start a held session in src/core.nix, running: pi",
		);
	});

	it("says the node's reason and opens nothing when nothing starts", async () => {
		const kitty = fakeDriver("kitty");
		const { start } = node({
			ok: false,
			reason: "no link reaches equilibrius now",
		});
		const outcome = await spawnHeld(asked(kitty), start);
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
		const outcome = await spawnHeld({ ...asked(kitty), needs: [home] }, start);
		expect(starts[0]?.needs).toEqual([home]);
		expect(outcome.ok && outcome.message).toContain(
			"The node chose equilibrius for reach=home. Started a held session",
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
		expect(asked).toHaveLength(1);
	});
});
