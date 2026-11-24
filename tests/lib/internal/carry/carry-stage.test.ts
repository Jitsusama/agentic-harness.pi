/**
 * A carry staged before it reaches the handover: the share sends what it
 * finds there at once, so nothing of a carry may land there before the
 * carry stands, and a carry that fails leaves what an earlier one left.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import {
	CarryNotWhole,
	carryAway,
	carryQuestTrees,
} from "../../../../lib/internal/carry/carry-away.ts";
import { readHandover } from "../../../../lib/internal/carry/handover.ts";
import { git } from "../../../support/git-fixture.ts";
import {
	bareOrigin,
	cloneAt,
	commit,
	exec,
	folder,
	removeAll,
} from "./support/machines.ts";

/** The sessions whose done file can't be written, and what happens first. */
const failing = vi.hoisted(() => new Map<string, () => void>());

/** Every rename made, as from and to, in order. */
const renames = vi.hoisted((): [string, string][] => []);

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		renameSync: (...args: Parameters<typeof real.renameSync>) => {
			renames.push([String(args[0]), String(args[1])]);
			real.renameSync(...args);
		},
	};
});

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
				const fail = failing.get(args[1].session);
				if (fail !== undefined) {
					fail();
					throw new Error("the disk is full");
				}
				return real.writeHandover(...args);
			},
		};
	},
);

const made: string[] = [];
afterEach(() => {
	failing.clear();
	renames.length = 0;
	removeAll(made);
});

/** Whether this runs as root, whom a folder's mode doesn't stop. */
const ROOT = process.getuid?.() === 0;

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

/**
 * A staging folder `name` in the tmp/ beside `into`, as a carry whose
 * process is gone would leave it, its record holding `record`.
 */
function plant(into: string, name: string, record: object): string {
	const left = join(dirname(dirname(into)), "tmp", name);
	mkdirSync(join(left, ".before"), { recursive: true });
	writeFileSync(
		join(left, ".carry.json"),
		JSON.stringify({
			into,
			owner: "s-p",
			machine: hostname(),
			pid: spawnSync(process.execPath, ["-e", ""]).pid,
			placed: [],
			...record,
		}),
	);
	return left;
}

/** A folder outside the handover holding a file someone keeps. */
function outsideWithVictim(): string {
	const outside = folder(made, "outside");
	writeFileSync(join(outside, "victim.txt"), "kept\n");
	return outside;
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
		failing.set("s-d", () => {});

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

	it("takes out what a session's earlier carry named and its next one doesn't, leaving another session's", async () => {
		const { origin, home, tree, into } = await homeWithWork();
		const other = await cloneAt(origin, join(home, "src", "lib"));
		await git(other, "checkout", "-q", "-b", "side");
		await commit(other, "side.txt", "unpushed\n");
		const carry = (session: string, trees: string[]) =>
			carryAway({
				exec,
				into,
				home,
				quest: QUEST,
				session: { id: session, cwd: tree },
				trees,
				whole: true,
			});
		const first = await carry("s-s", [tree, other]);
		const beside = await carry("s-b", [other]);
		const named = (carried: typeof first) =>
			carried.handover.trees.flatMap((one) =>
				[one.bundle, one.patch].filter((name) => name !== undefined),
			);
		const dropped = named(first).filter((name) => name.startsWith("lib-"));
		expect(dropped, "its first carry bundled the second tree").not.toEqual([]);

		const next = await carry("s-s", [tree]);

		expect(Object.keys(filesIn(into)).sort()).toEqual(
			[
				...named(next),
				...named(beside),
				"s-s.done.json",
				"s-b.done.json",
			].sort(),
		);
		for (const name of dropped) {
			expect(existsSync(join(into, name)), `${name} is gone`).toBe(false);
		}
		expect(staging(into)).toEqual([]);
	});

	it("refuses a quest's tree whose bundle the share would refuse, leaving none of it to send", async () => {
		const { home, tree, into } = await homeWithWork();
		await commit(tree, "big.txt", "unpushed\n".repeat(400));

		const { trees, file } = await carryQuestTrees(
			exec,
			[tree],
			into,
			home,
			QUEST,
			200,
		);

		expect(file, "no done file of no trees").toBeUndefined();
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

	it("takes out what a quest's earlier carry of its own trees named and its next one doesn't", async () => {
		const { origin, home, tree, into } = await homeWithWork();
		const other = await cloneAt(origin, join(home, "src", "lib"));
		await git(other, "checkout", "-q", "-b", "side");
		await commit(other, "side.txt", "unpushed\n");
		const first = await carryQuestTrees(exec, [tree, other], into, home, QUEST);
		const dropped = Object.keys(filesIn(into)).filter((name) =>
			name.startsWith("lib-"),
		);
		expect(first.file).toBe(join(into, `${QUEST}.done.json`));
		expect(dropped, "its first carry bundled the second tree").not.toEqual([]);

		const next = await carryQuestTrees(exec, [tree], into, home, QUEST);

		expect(next.file).toBe(join(into, `${QUEST}.done.json`));
		expect(
			Object.keys(filesIn(into)).sort(),
			"only its own tree's bundle and patch, and its new done file",
		).toEqual(
			[
				...next.trees.flatMap((one) =>
					one.kind === "carried"
						? [one.tree.bundle, one.tree.patch].filter(
								(name) => name !== undefined,
							)
						: [],
				),
				`${QUEST}.done.json`,
			].sort(),
		);
		expect(
			readHandover(join(into, `${QUEST}.done.json`))?.trees.map(
				(one) => one.path,
			),
		).toEqual(["~/src/app"]);
		expect(staging(into)).toEqual([]);
	});

	it("takes out a quest's earlier carry of its own trees when its next one hands none", async () => {
		const { home, tree, into } = await homeWithWork();
		await carryQuestTrees(exec, [tree], into, home, QUEST);
		expect(Object.keys(filesIn(into))).toContain(`${QUEST}.done.json`);
		await git(tree, "checkout", "-q", "--detach");

		const next = await carryQuestTrees(exec, [tree], into, home, QUEST);

		expect(next.trees.map((one) => one.kind)).toEqual(["skipped"]);
		expect(next.file).toBeUndefined();
		expect(
			filesIn(into),
			"no done file names a tree this carry skipped",
		).toEqual({});
		expect(staging(into)).toEqual([]);
	});

	it("puts back a quest's earlier carry of its own trees when its next done file can't be written", async () => {
		const { origin, home, tree, into } = await homeWithWork();
		const other = await cloneAt(origin, join(home, "src", "lib"));
		await git(other, "checkout", "-q", "-b", "side");
		await commit(other, "side.txt", "unpushed\n");
		const mine = await cloneAt(origin, join(home, "src", "mine"));
		await git(mine, "checkout", "-q", "-b", "own");
		await commit(mine, "own.txt", "unpushed\n");
		await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-b", cwd: mine },
			trees: [mine],
			whole: true,
		});
		await carryQuestTrees(exec, [tree, other], into, home, QUEST);
		const before = filesIn(into);
		const dropped = Object.keys(before).filter((name) =>
			name.startsWith("lib-"),
		);
		expect(dropped, "its first carry bundled the second tree").not.toEqual([]);
		await commit(tree, "later.txt", "after its first carry\n");
		let asideWhileWriting: string[] = [];
		failing.set(QUEST, () => {
			asideWhileWriting = dropped.filter(
				(name) => !existsSync(join(into, name)),
			);
		});

		await expect(
			carryQuestTrees(exec, [tree], into, home, QUEST),
		).rejects.toThrow("the disk is full");

		expect(
			asideWhileWriting,
			"what only its first carry named was out while it wrote",
		).toEqual(dropped);
		expect(
			filesIn(into),
			"its first carry, and the session's beside it, are as they were",
		).toEqual(before);
		expect(staging(into)).toEqual([]);
	});

	it("moves a session's earlier done file aside before any new bundle lands", async () => {
		const { home, tree, into } = await homeWithWork();
		const carry = () =>
			carryAway({
				exec,
				into,
				home,
				quest: QUEST,
				session: { id: "s-o", cwd: tree },
				trees: [tree],
				whole: true,
			});
		await carry();
		await commit(tree, "later.txt", "after its first carry\n");
		renames.length = 0;

		const next = await carry();

		const bundle = join(into, next.handover.trees[0]?.bundle ?? "none");
		const aside = renames.findIndex(
			([from]) => from === join(into, "s-o.done.json"),
		);
		const landed = renames.findIndex(([, to]) => to === bundle);
		expect(aside, "its earlier done file went aside").toBeGreaterThanOrEqual(0);
		expect(landed, "its new bundle landed").toBeGreaterThan(aside);
	});

	it("fails rather than delete a folder at its done file's name", async () => {
		const { home, tree, into } = await homeWithWork();
		const held = join(into, "s-f.done.json");
		mkdirSync(held, { recursive: true });
		writeFileSync(join(held, "kept.txt"), "someone's\n");

		await expect(
			carryAway({
				exec,
				into,
				home,
				quest: QUEST,
				session: { id: "s-f", cwd: tree },
				trees: [tree],
				whole: true,
			}),
		).rejects.toThrow();

		expect(readFileSync(join(held, "kept.txt"), "utf8")).toBe("someone's\n");
		expect(filesIn(into), "its bundle and patch were taken out").toEqual({});
		expect(staging(into)).toEqual([]);
	});

	it("leaves a file its earlier done file names that no carry of its own writes", async () => {
		const { home, tree, into } = await homeWithWork();
		const carry = () =>
			carryAway({
				exec,
				into,
				home,
				quest: QUEST,
				session: { id: "s-n", cwd: tree },
				trees: [tree],
				whole: true,
			});
		const first = await carry();
		writeFileSync(join(into, "theirs.bundle"), "another carry's\n");
		writeFileSync(join(into, "s-x.done.json"), "{}\n");
		const done = JSON.parse(readFileSync(first.file, "utf8"));
		done.sessionFile = "s-x.done.json";
		done.trees[0].patch = "theirs.bundle";
		writeFileSync(first.file, JSON.stringify(done));

		await carry();

		expect(readFileSync(join(into, "theirs.bundle"), "utf8")).toBe(
			"another carry's\n",
		);
		expect(readFileSync(join(into, "s-x.done.json"), "utf8")).toBe("{}\n");
	});

	it.skipIf(ROOT)(
		"names what couldn't go back, and the next carry puts it back once its process is gone",
		async () => {
			const { home, tree, into } = await homeWithWork();
			const carry = () =>
				carryAway({
					exec,
					into,
					home,
					quest: QUEST,
					session: { id: "s-k", cwd: tree },
					trees: [tree],
					whole: true,
				});
			await carry();
			const before = filesIn(into);
			await commit(tree, "later.txt", "after its first carry\n");
			// As a carry killed after placing: nothing in the handover can move.
			failing.set("s-k", () => chmodSync(into, 0o500));

			try {
				await expect(carry()).rejects.toThrow(
					/the disk is full; .*\.bundle.* couldn't be taken out of [^;]*; .*s-k\.done\.json.* couldn't be put back, and wait in /,
				);
			} finally {
				chmodSync(into, 0o755);
			}
			failing.clear();
			expect(existsSync(join(into, "s-k.done.json"))).toBe(false);
			const [kept] = staging(into);
			expect(kept, "its staging folder waits").toMatch(/^carrying-/);
			const tmp = join(dirname(dirname(into)), "tmp");
			const sweepBy = () => carryQuestTrees(exec, [], into, home, QUEST);

			await sweepBy();
			expect(staging(into), "its process still runs").toEqual([kept]);

			const record = join(tmp, kept ?? "none", ".carry.json");
			const gone = spawnSync(process.execPath, ["-e", ""]).pid;
			writeFileSync(
				record,
				JSON.stringify({
					...JSON.parse(readFileSync(record, "utf8")),
					pid: gone,
				}),
			);
			await sweepBy();

			expect(filesIn(into), "its first carry is back").toEqual(before);
			expect(staging(into)).toEqual([]);
		},
	);

	it("drops a staging folder whose carry stood before its process went", async () => {
		const { home, tree, into } = await homeWithWork();
		await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-g", cwd: tree },
			trees: [tree],
			whole: true,
		});
		const after = filesIn(into);
		const tmp = join(dirname(dirname(into)), "tmp");
		const left = join(tmp, "carrying-left");
		mkdirSync(join(left, ".before"), { recursive: true });
		writeFileSync(join(left, ".before", "s-g.done.json"), "older\n");
		const placed = Object.keys(after).filter(
			(name) => name !== "s-g.done.json",
		);
		writeFileSync(
			join(left, ".carry.json"),
			JSON.stringify({
				into,
				owner: "s-g",
				machine: hostname(),
				pid: spawnSync(process.execPath, ["-e", ""]).pid,
				placed,
			}),
		);

		await carryQuestTrees(exec, [], into, home, QUEST);

		expect(filesIn(into), "what it placed stays").toEqual(after);
		expect(staging(into)).toEqual([]);
	});

	it("leaves a record naming another folder, or a name that climbs out, and what it names", async () => {
		const { home, into } = await homeWithWork();
		mkdirSync(into, { recursive: true });
		const outside = outsideWithVictim();
		const victim = join(outside, "victim.txt");
		plant(into, "carrying-elsewhere", {
			into: outside,
			placed: ["victim.txt"],
		});
		plant(into, "carrying-climbs", { placed: [relative(into, victim)] });
		plant(into, "carrying-owner", { owner: "../s-p" });

		await carryQuestTrees(exec, [], into, home, QUEST);

		expect(readFileSync(victim, "utf8")).toBe("kept\n");
		expect(staging(into).sort(), "none of them is swept").toEqual([
			"carrying-climbs",
			"carrying-elsewhere",
			"carrying-owner",
		]);
	});

	it("leaves a staging folder, or its .before, that is a link to another folder", async () => {
		const { home, into } = await homeWithWork();
		mkdirSync(into, { recursive: true });
		const outside = outsideWithVictim();
		const linked = plant(into, "carrying-linked", {});
		rmSync(join(linked, ".before"), { recursive: true });
		symlinkSync(outside, join(linked, ".before"));
		const away = folder(made, "away");
		mkdirSync(join(away, ".before"));
		writeFileSync(join(away, ".before", "victim.txt"), "theirs\n");
		symlinkSync(away, join(dirname(dirname(into)), "tmp", "carrying-whole"));
		writeFileSync(
			join(away, ".carry.json"),
			JSON.stringify({
				into,
				owner: "s-p",
				machine: hostname(),
				pid: spawnSync(process.execPath, ["-e", ""]).pid,
				placed: [],
			}),
		);

		await carryQuestTrees(exec, [], into, home, QUEST);

		expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("kept\n");
		expect(readFileSync(join(away, ".before", "victim.txt"), "utf8")).toBe(
			"theirs\n",
		);
		expect(filesIn(into), "nothing is put back through a link").toEqual({});
		expect(staging(into)).toContain("carrying-linked");
		expect(staging(into)).toContain("carrying-whole");
	});

	it("sweeps a record whose next write was cut off, by the one before it", async () => {
		const { home, into } = await homeWithWork();
		mkdirSync(into, { recursive: true });
		writeFileSync(join(into, "app-placed.bundle"), "half a carry\n");
		const left = plant(into, "carrying-cut", {
			placed: ["app-placed.bundle"],
		});
		writeFileSync(join(left, ".carry.json.writing"), '{"into":');

		await carryQuestTrees(exec, [], into, home, QUEST);

		expect(filesIn(into), "what it placed is taken out").toEqual({});
		expect(staging(into)).toEqual([]);
	});

	it("fails before moving anything when a folder stands at a name it places", async () => {
		const { home, tree, into } = await homeWithWork();
		const carry = () =>
			carryAway({
				exec,
				into,
				home,
				quest: QUEST,
				session: { id: "s-h", cwd: tree },
				trees: [tree],
				whole: true,
			});
		const first = await carry();
		const bundle = first.handover.trees[0]?.bundle ?? "none";
		rmSync(into, { recursive: true });
		mkdirSync(join(into, bundle), { recursive: true });
		writeFileSync(join(into, bundle, "kept.txt"), "someone's\n");
		renames.length = 0;

		await expect(carry()).rejects.toThrow(
			`A folder stands at ${join(into, bundle)}`,
		);

		expect(readFileSync(join(into, bundle, "kept.txt"), "utf8")).toBe(
			"someone's\n",
		);
		expect(filesIn(into)).toEqual({});
		expect(
			renames.filter(([, to]) => dirname(to) === into),
			"nothing was renamed into the handover",
		).toEqual([]);
		expect(staging(into)).toEqual([]);
	});
});
