/**
 * A carry staged before it reaches the handover: the share sends what it
 * finds there at once, so nothing of a carry may land there before the
 * carry stands, and a carry that fails leaves what an earlier one left.
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import {
	CarryNotWhole,
	carryAway,
	carryTrees,
} from "../../../../lib/internal/carry/carry-away.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	bareOrigin,
	cloneAt,
	commit,
	exec,
	folder,
	removeAll,
} from "./support/machines.ts";

/** The sessions whose done file can't be written. */
const failing = vi.hoisted(() => new Set<string>());

vi.mock(
	"../../../../lib/internal/carry/handover.ts",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../../../../lib/internal/carry/handover.ts")
			>();
		return {
			...real,
			writeHandover: (
				...args: Parameters<typeof real.writeHandover>
			): string => {
				if (failing.has(args[1].session)) throw new Error("the disk is full");
				return real.writeHandover(...args);
			},
		};
	},
);

const made: string[] = [];
afterEach(() => {
	failing.clear();
	removeAll(made);
});

const QUEST = "QEST-20261107-CARRY2";

/** A home with a clone of a fresh origin at `~/src/app`, on a branch with work. */
async function homeWithWork() {
	const origin = await bareOrigin(made);
	const home = folder(made, "home");
	const tree = await cloneAt(origin, join(home, "src", "app"));
	await git(tree, "checkout", "-q", "-b", "topic");
	await commit(tree, "work.txt", "unpushed\n");
	writeFileSync(join(tree, "README.md"), "changed\n");
	const into = join(folder(made, "scratch"), QUEST, "handover", "aquifer");
	return { origin, home, tree, into };
}

/** Every file in `into`, by name, as its bytes. */
function filesIn(into: string) {
	return Object.fromEntries(
		readdirSync(into)
			.filter((name) => statSync(join(into, name)).isFile())
			.map((name) => [name, readFileSync(join(into, name))]),
	);
}

/** What the quest scratch's tmp/ holds beside the handover `into`. */
function staging(into: string): string[] {
	const tmp = join(dirname(dirname(into)), "tmp");
	return existsSync(tmp) ? readdirSync(tmp) : [];
}

describe("a carry staged before the handover", () => {
	it("puts nothing in the handover while it carries, then the whole carry at once", async () => {
		const { home, tree, into } = await homeWithWork();
		const seen: string[][] = [];
		const watching: Exec = async (command, args) => {
			const answer = await exec(command, args);
			seen.push(existsSync(into) ? readdirSync(into) : []);
			return answer;
		};

		const carried = await carryAway({
			exec: watching,
			into,
			home,
			quest: QUEST,
			session: { id: "s-w", cwd: tree },
			trees: [tree],
			whole: true,
		});

		expect(seen.length, "it ran git while carrying").toBeGreaterThan(0);
		expect(
			seen.flat().filter((name) => /\.(bundle|patch)$/.test(name)),
			"no bundle or patch reached the share before the carry stood",
		).toEqual([]);
		const tree0 = carried.handover.trees[0];
		expect(tree0?.bundle).toBeDefined();
		expect(tree0?.patch).toBeDefined();
		expect(existsSync(join(into, tree0?.bundle ?? "none"))).toBe(true);
		expect(existsSync(join(into, tree0?.patch ?? "none"))).toBe(true);
		expect(staging(into), "its staging folder is gone").toEqual([]);
	});

	it("leaves a session's earlier carry as it was when its next one is refused", async () => {
		const { home, tree, into } = await homeWithWork();
		await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-r", cwd: tree },
			trees: [tree],
			whole: true,
		});
		const before = filesIn(into);
		await commit(tree, "later.txt", "after its first carry\n");
		writeFileSync(join(tree, "README.md"), "changed again\n");

		await expect(
			carryAway({
				exec,
				into,
				home,
				quest: QUEST,
				session: { id: "s-r", cwd: tree },
				trees: [tree, folder(made, "plain")],
				whole: true,
			}),
		).rejects.toBeInstanceOf(CarryNotWhole);

		expect(
			filesIn(into),
			"its bundle, patch and done file are those of its first carry",
		).toEqual(before);
		expect(staging(into)).toEqual([]);
	});

	it("puts back a session's earlier carry when its next done file can't be written", async () => {
		const { home, tree, into } = await homeWithWork();
		const file = join(folder(made, "sessions"), "2026-11-07_s-d.jsonl");
		writeFileSync(file, '{"type":"session","id":"s-d"}\n');
		await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-d", cwd: tree, file },
			trees: [tree],
			whole: true,
		});
		const before = filesIn(into);
		await commit(tree, "later.txt", "after its first carry\n");
		writeFileSync(file, '{"type":"message"}\n'.repeat(500));
		failing.add("s-d");

		await expect(
			carryAway({
				exec,
				into,
				home,
				quest: QUEST,
				session: { id: "s-d", cwd: tree, file },
				trees: [tree],
				largestFile: 4000,
				whole: true,
			}),
		).rejects.toThrow("the disk is full");

		expect(
			filesIn(into),
			"its gzipped file and new bundle are taken out, and its first carry's put back",
		).toEqual(before);
		expect(staging(into)).toEqual([]);
	});

	it("refuses a quest's tree whose bundle the share would refuse, leaving none of it to send", async () => {
		const { home, tree, into } = await homeWithWork();
		await commit(tree, "big.txt", "unpushed\n".repeat(400));

		const trees = await carryTrees(exec, [tree], into, home, QUEST, 200);

		expect(trees).toEqual([
			{
				kind: "refused",
				path: tree,
				why: expect.stringMatching(
					/^Its .*\.bundle is \d+ bytes, over the 200 bytes the share carries\.$/,
				),
			},
		]);
		expect(readdirSync(into)).toEqual([]);
		expect(staging(into)).toEqual([]);
	});
});
