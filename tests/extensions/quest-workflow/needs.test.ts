import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/frontmatter";
import {
	clearTerminalDrivers,
	registerTerminalDriver,
} from "../../../lib/terminal/index";
import { createEnvGuard, journeyOf, refused, succeeded } from "./_helpers";

let tmpRoot: string;
let spawned: string | undefined;
const kept: Record<string, string | undefined> = {};

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
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
	for (const key of ["HOME", "XDG_STATE_HOME", "MYCELIUM_REALM"]) {
		kept[key] = process.env[key];
	}
	process.env.HOME = tmpRoot;
	process.env.XDG_STATE_HOME = join(tmpRoot, "state");
	delete process.env.MYCELIUM_REALM;
	spawned = undefined;
	clearTerminalDrivers();
	registerTerminalDriver({
		id: "fake",
		available: () => true,
		async spawn(req) {
			spawned = req.command;
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

	it("are replaced, not added to, by needs the spawn names", async () => {
		const { id, run } = await quest("Alpha");
		await run({ action: "need-add", ref: "system=macos" });

		succeeded(await run({ action: "spawn-tab", id, needs: [] }));

		expect(spawned, "it started here, asking no node").toBe("pi");
	});
});
