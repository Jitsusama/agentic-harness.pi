import { describe, expect, it } from "vitest";
import {
	claimRunning,
	placementFence,
	runsPi,
	spawnFenced,
	spawnSettled,
} from "../../../../extensions/quest-workflow/verbs/spawn-stage.ts";
import { declarationSettled } from "../../../../lib/internal/fence/fence-declaration.ts";
import { joinSpawns } from "../../../../lib/internal/fence/fence-stage.ts";

const declared = { kind: "fence", from: "spawn" } as const;
const unfenced = { kind: "none", from: "default" };
const session = "019a0000-0000-7000-8000-000000000001";

describe("the fence a spawn tells the node when asking where it runs", () => {
	const strictDeclared = { kind: "strict", from: "spawn" } as const;

	it("is the strict one declared for a fresh spawn, which no pi lifts", () => {
		expect(
			placementFence(strictDeclared, { resumes: false }),
			"nothing to resume",
		).toEqual(strictDeclared);
		expect(
			placementFence(strictDeclared, {
				command: "pi --model x",
				resumes: true,
			}),
			"a command of the caller's own resumes nothing",
		).toEqual(strictDeclared);
	});

	it("is none for a declared fence, which a pi on another machine may lift", () => {
		expect(
			placementFence(declared, { resumes: false }),
			"before it's known where it lands",
		).toEqual(unfenced);
	});

	it("is none for one that may reopen, which is given no sandbox", () => {
		expect(
			placementFence(declared, {
				command: `pi --session ${session}`,
				resumes: false,
			}),
			"a command that reopens",
		).toEqual(unfenced);
		expect(
			placementFence(declared, { resumes: true }),
			"a session it would resume",
		).toEqual(unfenced);
	});

	it("is none for a command that isn't pi, which reads none of the fence's variables", () => {
		expect(
			placementFence(declared, { command: "bash -lc make", resumes: false }),
			"a shell",
		).toEqual(unfenced);
		expect(
			placementFence(
				{ kind: "strict", from: "default" },
				{ command: "htop", resumes: false },
			),
			"a strict parent's command that isn't pi",
		).toEqual(unfenced);
	});

	it("is none for an undeclared fence, which a held start runs without", () => {
		expect(
			placementFence({ kind: "fence", from: "default" }, { resumes: false }),
			"the stage's fence, before it's known where it starts",
		).toEqual(unfenced);
		const strict = { kind: "strict", from: "default" } as const;
		expect(
			placementFence(strict, { resumes: false }),
			"a strict parent's child, which every start hands strict",
		).toEqual(strict);
	});
});

describe("how a spawn starts, for the claim it settles", () => {
	const fresh = { questId: "QEST-1", listed: true, held: false, here: true };
	const staged = { kind: "fence", from: "default" } as const;

	it("carries no token to a held start, so an undeclared staged fence claims none there", () => {
		const held = spawnSettled({ ...fresh, held: true, here: false });
		expect(held.carried, "a held start carried the token").toBe(false);
		expect(
			declarationSettled(staged, held),
			"the node's Start was told the stage's fence",
		).toEqual(unfenced);
		expect(
			declarationSettled(staged, spawnSettled(fresh)),
			"one opened here keeps the stage's fence",
		).toEqual(staged);
	});

	it("stages a dry run as the stage would list it, though nothing was listed", () => {
		const dry = { ...fresh, listed: false, dryRun: true };
		expect(spawnSettled(dry).staged, "before spawns join").toBe(false);
		joinSpawns("the test lets spawns join");
		expect(spawnSettled(dry).staged, "once spawns join").toBe(true);
		expect(
			spawnSettled({ ...dry, command: `pi --session ${session}` }).staged,
			"a reopen, which the stage leaves alone",
		).toBe(false);
	});

	it("says a reopen and a command that isn't pi, and keeps a declared fence's mark", () => {
		expect(
			spawnSettled({ ...fresh, resuming: session }),
			"a picked session",
		).toMatchObject({ reopens: true });
		expect(
			spawnSettled({ ...fresh, command: "bash" }),
			"a shell",
		).toMatchObject({ pi: false });
		expect(spawnSettled(fresh, "linux"), "a fresh pi").toMatchObject({
			reopens: false,
			pi: true,
			kept: true,
		});
	});

	it("keeps a declared fence only in a pi of this install on Linux", () => {
		const settledFor = (spawn: typeof fresh, platform: NodeJS.Platform) =>
			declarationSettled(declared, spawnSettled(spawn, platform));
		expect(
			settledFor({ ...fresh, held: true }, "linux"),
			"held by the node on this machine, which runs this install",
		).toEqual(declared);
		expect(
			settledFor({ ...fresh, held: true, here: false }, "linux"),
			"held on another machine, whose pi may be older and lift it",
		).toEqual(unfenced);
		expect(
			settledFor(fresh, "darwin"),
			"opened on a Mac, whose pi lifts it",
		).toEqual(unfenced);
		const strict = { kind: "strict", from: "spawn" } as const;
		expect(
			declarationSettled(
				strict,
				spawnSettled({ ...fresh, held: true, here: false }, "darwin"),
			),
			"strict, which no pi lifts and a Mac's refuses all under",
		).toEqual(strict);
	});
});

describe("the fence a started spawn claims and is handed", () => {
	const here = { questId: "QEST-1", listed: true, held: false, here: true };
	const elsewhere = { ...here, held: true, here: false };
	const strict = { kind: "strict", from: "default" } as const;

	it("hands a declared fence on wherever it lands, claiming it only where its pi keeps it", () => {
		expect(
			spawnFenced(declared, here, "linux"),
			"opened here on Linux",
		).toEqual({ claim: declared, sandbox: "fence" });
		expect(
			spawnFenced(declared, elsewhere, "linux"),
			"held on another machine",
		).toEqual({ claim: unfenced, sandbox: "fence" });
		expect(spawnFenced(declared, here, "darwin"), "opened on a Mac").toEqual({
			claim: unfenced,
			sandbox: "fence",
		});
	});

	it("hands a strict parent's child strict wherever it lands, and claims it", () => {
		expect(spawnFenced(strict, elsewhere, "darwin")).toEqual({
			claim: strict,
			sandbox: "strict",
		});
	});

	it("hands a reopen nothing and the stage's fence nothing, which the token carries", () => {
		expect(
			spawnFenced(declared, { ...here, resuming: session }, "linux"),
			"a reopen keeps its own",
		).toEqual({ claim: unfenced, sandbox: undefined });
		const staged = { kind: "fence", from: "default" } as const;
		expect(spawnFenced(staged, here, "linux"), "the stage's fence").toEqual({
			claim: staged,
			sandbox: undefined,
		});
	});
});

describe("whether a spawn's command runs pi", () => {
	it("counts no command, and one whose first word names pi", () => {
		for (const command of [
			undefined,
			"",
			"  ",
			"pi",
			"pi --model x",
			"/nix/store/abc-pi/bin/pi -c",
		]) {
			expect(runsPi(command), `${JSON.stringify(command)} runs pi`).toBe(true);
		}
	});

	it("counts nothing else, even a command that starts pi another way", () => {
		for (const command of [
			"bash",
			"env X=1 pi",
			"pip install x",
			"./pirate",
			"pi && bash",
			"pi; make",
			"pi || sh",
			"pi | tee log",
			"pi $(cat flags)",
			"pi\nbash",
			"pi --no-extensions",
			"pi -ne -e ./x.ts",
		]) {
			expect(runsPi(command), `${command} counted as pi`).toBe(false);
		}
	});
});

describe("the claim once what a spawn runs is known", () => {
	it("stays what was settled when it runs the pi it asked for", () => {
		expect(
			claimRunning(declared, "pi", "pi"),
			"nothing was swapped in",
		).toEqual(declared);
	});

	it("is none once a realm's own agent is swapped in, which may not pass pi's variables on", () => {
		expect(
			claimRunning(declared, "pi", "pi-claude"),
			"a realm's agent claims nothing",
		).toEqual(unfenced);
		expect(
			claimRunning({ kind: "strict", from: "quest" }, "pi -c", "pi-claude -c"),
			"strict as well",
		).toEqual(unfenced);
	});
});
