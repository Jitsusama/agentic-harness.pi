/**
 * What `pi-carry` carries of a quest once its steered sessions have
 * carried their own, through real git.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { carryAway } from "../../../../lib/internal/carry/carry-away.ts";
import { readHandover } from "../../../../lib/internal/carry/handover.ts";
import type { QuestHere } from "../../../../lib/internal/carry/quest-here.ts";
import {
	carryRest,
	type RestLine,
} from "../../../../lib/internal/carry/rest.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	bareOrigin,
	cloneAt,
	commit,
	exec,
	folder,
	removeAll,
} from "./support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

const QUEST = "QEST-20261107-CARRY1";

/** A home with clones of one origin at `~/src/<name>` for each name. */
async function homeWith(...names: string[]) {
	const origin = await bareOrigin(made);
	const home = folder(made, "home");
	const trees: Record<string, string> = {};
	for (const name of names) {
		trees[name] = await cloneAt(origin, join(home, "src", name));
	}
	const into = join(folder(made, "scratch"), QUEST, "handover", "aquifer");
	return { home, trees, into };
}

/** A session file for `id`, as pi keeps one. */
function sessionFile(id: string): string {
	const file = join(folder(made, "sessions"), `2026-11-07_${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", id })}\n`);
	return file;
}

function questHere(over: Partial<QuestHere>): QuestHere {
	return {
		quest: QUEST,
		resting: [],
		sessions: new Set(),
		held: [],
		trees: [],
		...over,
	};
}

async function carry(home: string, into: string, here: QuestHere) {
	const said: RestLine[] = [];
	const whole = await carryRest({
		exec,
		into,
		home,
		here,
		say: (line) => said.push(line),
	});
	return { whole, said };
}

describe("carrying what a quest's steered sessions left", () => {
	it("carries each resting session with the trees it holds, and none already carried", async () => {
		const { home, trees, into } = await homeWith("app", "lib");
		await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-steered", cwd: trees.lib ?? "" },
			trees: [trees.lib ?? ""],
		});
		const file = sessionFile("s-rest");

		const { whole, said } = await carry(
			home,
			into,
			questHere({
				resting: [
					{ id: "s-rest", cwd: trees.app ?? "", title: "Resting", file },
					{ id: "s-steered", cwd: trees.lib ?? "" },
				],
				held: [
					{ path: trees.app ?? "", sessions: ["s-rest"] },
					{ path: trees.lib ?? "", sessions: ["s-steered", "s-rest"] },
				],
			}),
		);

		expect(whole, "every tree went").toBe(true);
		expect(said.at(-1)).toEqual({
			kind: "done",
			files: [join(into, "s-rest.done.json")],
		});
		expect(readHandover(join(into, "s-rest.done.json"))).toMatchObject({
			session: "s-rest",
			cwd: "~/src/app",
			title: "Resting",
			sessionFile: "2026-11-07_s-rest.jsonl",
			trees: [{ path: "~/src/app" }],
		});
	});

	it("carries the quest's trees no done file names under a done file named for it", async () => {
		const { home, trees, into } = await homeWith("listed", "orphan", "theirs");
		await git(trees.orphan ?? "", "checkout", "-q", "-b", "left");
		await commit(trees.orphan ?? "", "left.txt", "left behind\n");

		const { whole, said } = await carry(
			home,
			into,
			questHere({
				sessions: new Set(["s-closed"]),
				held: [
					{ path: trees.orphan ?? "", sessions: ["s-closed"] },
					{ path: trees.theirs ?? "", sessions: ["s-other-quest"] },
				],
				trees: [trees.listed ?? ""],
			}),
		);

		expect(whole, "every tree went").toBe(true);
		expect(said.at(-1)).toEqual({
			kind: "done",
			files: [join(into, `${QUEST}.done.json`)],
		});
		const done = readHandover(join(into, `${QUEST}.done.json`));
		expect(done).toMatchObject({ session: QUEST, quest: QUEST, cwd: "~" });
		expect(done?.sessionFile).toBeUndefined();
		expect(done?.trees.map((tree) => [tree.path, tree.branch])).toEqual([
			["~/src/listed", "main"],
			["~/src/orphan", "left"],
		]);
	});

	it("writes no done file for the quest when nothing of it is left", async () => {
		const { home, trees, into } = await homeWith("snapshot");
		await git(trees.snapshot ?? "", "checkout", "-q", "--detach");

		const { said } = await carry(
			home,
			into,
			questHere({ trees: [trees.snapshot ?? ""] }),
		);

		expect(said).toEqual([
			{
				kind: "tree",
				under: QUEST,
				path: trees.snapshot,
				did: "skipped",
				why: expect.any(String),
			},
			{ kind: "done", files: [] },
		]);
		expect(
			existsSync(join(into, `${QUEST}.done.json`)),
			"no done file is written for the quest",
		).toBe(false);
	});

	it("says which tree it refused, and that not everything went", async () => {
		const { home, trees, into } = await homeWith("stuck");
		await git(trees.stuck ?? "", "checkout", "-q", "--detach");
		writeFileSync(join(trees.stuck ?? "", "work.txt"), "would be lost\n");

		const { whole, said } = await carry(
			home,
			into,
			questHere({ trees: [trees.stuck ?? ""] }),
		);

		expect(whole, "a carry with a tree refused is not whole").toBe(false);
		expect(said[0]).toMatchObject({
			kind: "tree",
			did: "refused",
			path: trees.stuck,
		});
	});
});
