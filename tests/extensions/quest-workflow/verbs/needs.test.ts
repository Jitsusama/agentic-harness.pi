import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import {
	joinSpawns,
	STAGE_VARIABLE,
} from "../../../../lib/internal/fence/fence-stage.ts";
import { parseQuestFrontMatter } from "../../../../lib/internal/quest/documents/frontmatter.ts";
import {
	clearTerminalDrivers,
	registerTerminalDriver,
} from "../../../../lib/terminal/index.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { createEnvGuard, journeyOf, refused, succeeded } from "../_helpers.ts";

let tmpRoot: string;
let spawned: string | undefined;
let spawnedEnv: Readonly<Record<string, string | undefined>> | undefined;
const kept: Record<string, string | undefined> = {};

function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => "spawner", isPersisted: () => true },
	} as unknown as Parameters<typeof handle>[2];
}

const envGuard = createEnvGuard();
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "needs-"));
	// No realm is named here, so a spawn that asks the node is refused
	// for want of one, which says it asked.
	// Nor does this test's own sandbox reach what it spawns.
	for (const key of [
		"HOME",
		"XDG_STATE_HOME",
		"MYCELIUM_REALM",
		"PI_SANDBOX",
	]) {
		kept[key] = process.env[key];
	}
	process.env.HOME = tmpRoot;
	process.env.XDG_STATE_HOME = join(tmpRoot, "state");
	delete process.env.MYCELIUM_REALM;
	delete process.env.PI_SANDBOX;
	spawned = undefined;
	spawnedEnv = undefined;
	clearTerminalDrivers();
	registerTerminalDriver({
		id: "fake",
		available: () => true,
		async spawn(req) {
			spawned = req.command;
			spawnedEnv = req.env;
		},
	});
});
afterEach(() => {
	clearTerminalDrivers();
	for (const [key, value] of Object.entries(kept)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

async function quest(title: string) {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	succeeded(
		await handle(state, fakePi(), fakeCtx(), { action: "create", title }),
	);
	return {
		state,
		id: state.questId as string,
		dir: state.questDir as string,
		run: (params: Parameters<typeof handle>[3]) =>
			handle(state, fakePi(), fakeCtx(), params),
	};
}

function needsIn(dir: string): unknown {
	const readme = readFileSync(join(dir, "README.md"), "utf8");
	const parsed = parseQuestFrontMatter(readme);
	if (!parsed) throw new Error(`the README no longer parses:\n${readme}`);
	return parsed.frontMatter._extra?.needs;
}

function fenceIn(dir: string): unknown {
	const readme = readFileSync(join(dir, "README.md"), "utf8");
	const parsed = parseQuestFrontMatter(readme);
	if (!parsed) throw new Error(`the README no longer parses:\n${readme}`);
	return parsed.frontMatter._extra?.fence;
}

describe("a quest's needs of a machine", () => {
	it("are kept in its front matter as the node's words, and journalled", async () => {
		const { dir, run } = await quest("Alpha");

		const added = succeeded(
			await run({ action: "need-add", ref: "reach=home, system=macos" }),
		);

		expect(needsIn(dir), "both words are kept, in order").toEqual([
			"reach=home",
			"system=macos",
		]);
		expect(added.message).toContain("needs reach=home, system=macos");
		expect(journeyOf(dir)).toContain(
			"Needs of a machine: reach=home, system=macos.",
		);
	});

	it("refuse a word the node would not take, writing nothing", async () => {
		const { dir, run } = await quest("Alpha");
		const before = readFileSync(join(dir, "README.md"), "utf8");

		const result = refused(
			await run({ action: "need-add", ref: "reach=home,colour=blue" }),
		);

		expect(result.guidance).toContain('"colour=blue" is not a need');
		expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(before);
	});

	it("say a word already there is there, without writing it twice", async () => {
		const { dir, run } = await quest("Alpha");
		await run({ action: "need-add", ref: "reach=home" });

		const again = succeeded(
			await run({ action: "need-add", ref: "reach=home" }),
		);

		expect(again.message).toContain("already needs reach=home");
		expect(needsIn(dir)).toEqual(["reach=home"]);
	});

	it("can be said of a quest not loaded, by its id", async () => {
		const first = await quest("Alpha");
		const second = await quest("Beta");

		succeeded(
			await second.run({
				action: "need-add",
				id: first.id,
				ref: "arch=aarch64",
			}),
		);

		expect(needsIn(first.dir), "the named quest needs it").toEqual([
			"arch=aarch64",
		]);
		expect(needsIn(second.dir), "the loaded one is untouched").toBeUndefined();
	});

	it("are taken off one by one, leaving no key once none is left", async () => {
		const { dir, run } = await quest("Alpha");
		await run({ action: "need-add", ref: "reach=home,system=linux" });

		succeeded(await run({ action: "need-remove", ref: "reach=home" }));
		expect(needsIn(dir)).toEqual(["system=linux"]);

		const last = succeeded(
			await run({ action: "need-remove", ref: "system=linux" }),
		);
		expect(needsIn(dir), "an empty list leaves no key").toBeUndefined();
		expect(last.message).toContain("needs nothing of a machine now");
	});

	it("place a spawn given neither a machine nor needs", async () => {
		const { id, run } = await quest("Alpha");
		await run({ action: "need-add", ref: "system=macos" });

		const result = refused(await run({ action: "spawn-tab", id }));

		expect(result.guidance).toContain(
			"Nothing was started, since mycelium's node placed it nowhere",
		);
		expect(spawned, "no terminal was opened").toBeUndefined();
	});

	it("are a quest's own, so its subquest's spawn needs nothing", async () => {
		const parent = await quest("Alpha");
		await parent.run({ action: "need-add", ref: "system=macos" });
		const child = succeeded(
			await parent.run({
				action: "create",
				kind: "subquest",
				parent: parent.id,
				title: "Beta",
			}),
		);
		const childId = (child.details as { id: string }).id;

		succeeded(await parent.run({ action: "spawn-tab", id: childId }));

		expect(spawned, "the subquest started here, asking no node").toBe("pi");
	});

	it("are named one at a time, never with a fence beside them", async () => {
		const { dir, run } = await quest("Alpha");

		const result = refused(
			await run({ action: "need-add", ref: "reach=home", fence: "fence" }),
		);

		expect(result.guidance, "it says to name one").toContain("one at a time");
		expect(needsIn(dir), "no need was kept").toBeUndefined();
		expect(fenceIn(dir), "no fence was kept").toBeUndefined();
	});

	it("are replaced, not added to, by needs the spawn names", async () => {
		const { id, run } = await quest("Alpha");
		await run({ action: "need-add", ref: "system=macos" });

		succeeded(await run({ action: "spawn-tab", id, needs: [] }));

		expect(spawned, "it started here, asking no node").toBe("pi");
	});
});

describe("the fence a quest's spawns declare", () => {
	it("is kept beside its needs, and journalled", async () => {
		const { dir, run } = await quest("Alpha");

		const added = succeeded(await run({ action: "need-add", fence: "fence" }));

		expect(fenceIn(dir), "the fence is kept").toBe("fence");
		expect(added.details, "the details say it changed").toEqual({
			fence: "fence",
			changed: true,
		});
		expect(journeyOf(dir), "the journey says it").toContain(
			"Declares fence: its spawns tell the node so unless they name another.",
		);
	});

	it("refuses a word that names no fence, saying the two tests and writing nothing", async () => {
		const { dir, run } = await quest("Alpha");
		const before = readFileSync(join(dir, "README.md"), "utf8");

		const result = refused(await run({ action: "need-add", fence: "none" }));

		expect(result.guidance, "it names the words").toContain(
			'fence is fence or strict, not "none"',
		);
		expect(result.guidance, "it says the tests").toContain(
			"optimus's own credentials",
		);
		expect(
			readFileSync(join(dir, "README.md"), "utf8"),
			"the README is as it was",
		).toBe(before);
	});

	it("is cleared by need-remove, leaving no key", async () => {
		const { dir, run } = await quest("Alpha");
		await run({ action: "need-add", fence: "strict" });

		const removed = succeeded(
			await run({ action: "need-remove", fence: "strict" }),
		);

		expect(fenceIn(dir), "no fence key is left").toBeUndefined();
		expect(removed.message, "it says none is declared now").toContain(
			"declares no fence now",
		);
	});

	it("starts a fresh spawn here in the sandbox its quest declares, and says so", async () => {
		const { id, run } = await quest("Alpha");
		await run({ action: "need-add", fence: "fence" });

		const result = succeeded(await run({ action: "spawn-tab", id }));

		expect(spawnedEnv?.PI_SANDBOX, "its commands run fenced").toBe("fence");
		expect(result.message, "it says who declared it").toContain(
			"It runs fence, as its quest declares.",
		);
		expect(result.details, "the details carry it").toMatchObject({
			fence: { kind: "fence", from: "quest" },
		});
	});

	it("gives way to the fence a spawn names", async () => {
		const { id, run } = await quest("Alpha");
		await run({ action: "need-add", fence: "fence" });

		succeeded(await run({ action: "spawn-tab", id, fence: "strict" }));

		expect(spawnedEnv?.PI_SANDBOX, "the spawn's word wins").toBe("strict");
	});

	it("sets no sandbox when nobody declared one, so the stage decides as before", async () => {
		const { id, run } = await quest("Alpha");

		const result = succeeded(await run({ action: "spawn-tab", id }));

		expect(spawnedEnv?.PI_SANDBOX, "no sandbox is named").toBeUndefined();
		expect(result.message, "it says what truly runs").toContain(
			"It runs unfenced, declared by nobody.",
		);
	});

	it("claims the fence for an undeclared spawn the stage takes, which its token carries", async () => {
		const { id, run } = await quest("Alpha");
		joinSpawns("the test lets spawns join");

		const result = succeeded(await run({ action: "spawn-tab", id }));

		expect(spawnedEnv?.[STAGE_VARIABLE], "it carries its listing").toEqual(
			expect.any(String),
		);
		expect(spawnedEnv?.PI_SANDBOX, "the stage, not a name, fences it").toBe(
			undefined,
		);
		expect(result.details, "it claims what the stage runs").toMatchObject({
			fence: { kind: "fence", from: "default" },
		});
	});

	it("gives a reopen by command no sandbox and claims none, whatever was declared", async () => {
		const { id, run } = await quest("Alpha");
		const session = "019a0000-0000-7000-8000-000000000001";

		const result = succeeded(
			await run({
				action: "spawn-tab",
				id,
				fence: "fence",
				command: `pi --session ${session}`,
			}),
		);

		expect(spawnedEnv?.PI_SANDBOX, "a reopen keeps its own").toBe(undefined);
		expect(result.details, "it claims what a reopen runs").toMatchObject({
			fence: { kind: "none", from: "default" },
		});
	});

	it("keeps an undeclared spawn of a strict session strict, and only a declared fence lowers it", async () => {
		const { id, run } = await quest("Alpha");
		process.env.PI_SANDBOX = "strict";

		const kept = succeeded(await run({ action: "spawn-tab", id }));
		expect(spawnedEnv?.PI_SANDBOX, "the child keeps strict").toBe("strict");
		expect(kept.details, "the answer claims strict").toMatchObject({
			fence: { kind: "strict", from: "default" },
		});

		succeeded(await run({ action: "spawn-tab", id, fence: "fence" }));
		expect(spawnedEnv?.PI_SANDBOX, "a declared fence lowers it").toBe("fence");
	});

	it("refuses a spawn naming no fence it may declare, starting nothing", async () => {
		const { id, run } = await quest("Alpha");

		refused(await run({ action: "spawn-tab", id, fence: "off" }));

		expect(spawned, "no terminal was opened").toBeUndefined();
	});
});
