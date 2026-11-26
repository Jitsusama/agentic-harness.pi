/**
 * A carry staged on another volume than its handover: each quest's
 * scratch is a btrfs subvolume of its own, which answers a rename from
 * the staging folder beside it with EXDEV though the disk is the same.
 */

import { spawnSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { carryAway } from "../../../../lib/internal/carry/carry-away.ts";
import { SHARE_LARGEST_FILE } from "../../../../lib/internal/carry/handover.ts";
import { staged, stagingOf } from "../../../../lib/internal/carry/stage.ts";
import { CARRY_STAGING } from "../../../../lib/internal/sandbox/quest-folders.ts";
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

/** What happens once the file at a path is removed, by its path. */
const afterUnlink = vi.hoisted(() => new Map<string, () => void>());

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const staging = (path: string) => path.includes(`/${CARRY_STAGING}/`);
	return {
		...real,
		renameSync: (...args: Parameters<typeof real.renameSync>) => {
			const [from, to] = [String(args[0]), String(args[1])];
			if (staging(from) !== staging(to)) {
				throw Object.assign(
					new Error(`EXDEV: cross-device link not permitted, rename '${from}'`),
					{ code: "EXDEV" },
				);
			}
			real.renameSync(...args);
		},
		unlinkSync: (...args: Parameters<typeof real.unlinkSync>) => {
			real.unlinkSync(...args);
			const then = afterUnlink.get(String(args[0]));
			afterUnlink.delete(String(args[0]));
			then?.();
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
				if (failing.has(args[1].session)) throw new Error("the disk is full");
				return real.writeHandover(...args);
			},
		};
	},
);

const made: string[] = [];
afterEach(() => {
	failing.clear();
	afterUnlink.clear();
	removeAll(made);
});

const QUEST = "QEST-20261125-VOLUME";

/** A home with a clone on a branch with work, and a session's log. */
async function homeWithWork() {
	const origin = await bareOrigin(made);
	const home = folder(made, "home");
	const tree = await cloneAt(origin, join(home, "src", "app"));
	await git(tree, "checkout", "-q", "-b", "topic");
	await commit(tree, "work.txt", "unpushed\n");
	writeFileSync(join(tree, "README.md"), "changed\n");
	const file = join(folder(made, "sessions"), "2026-11-25_s-v.jsonl");
	writeFileSync(file, '{"type":"session","id":"s-v"}\n');
	const into = join(folder(made, "scratch"), QUEST, "handover", "kestrel");
	return { home, tree, file, into };
}

/** Every file in `into`, by name, as its bytes. */
function filesIn(into: string) {
	return Object.fromEntries(
		readdirSync(into)
			.filter((name) => statSync(join(into, name)).isFile())
			.map((name) => [name, readFileSync(join(into, name))]),
	);
}

describe("a carry staged on another volume than its handover", () => {
	it("places the whole carry, leaving nothing staged or half-moved", async () => {
		const { home, tree, file, into } = await homeWithWork();

		const carried = await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-v", cwd: tree, file },
			trees: [tree],
			whole: true,
		});

		const names = readdirSync(into);
		const tree0 = carried.handover.trees[0];
		expect(names).toContain(tree0?.bundle);
		expect(names).toContain(tree0?.patch);
		expect(
			names.some((name) => name.endsWith(".done.json")),
			`a done file is placed: ${names.join(" ")}`,
		).toBe(true);
		expect(
			names.filter((name) => name.includes(".moving-")),
			"no copy is left beside its place",
		).toEqual([]);
		expect(readdirSync(stagingOf(into)), "its staging folder is gone").toEqual(
			[],
		);
	});

	it("puts back an earlier carry across volumes when the next one's done file can't be written", async () => {
		const { home, tree, file, into } = await homeWithWork();
		await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session: { id: "s-v", cwd: tree, file },
			trees: [tree],
			whole: true,
		});
		const before = filesIn(into);
		await commit(tree, "later.txt", "after its first carry\n");
		writeFileSync(file, '{"type":"message"}\n'.repeat(50));
		failing.add("s-v");

		await expect(
			carryAway({
				exec,
				into,
				home,
				quest: QUEST,
				session: { id: "s-v", cwd: tree, file },
				trees: [tree],
				whole: true,
			}),
		).rejects.toThrow("the disk is full");

		expect(filesIn(into), "its first carry is as it was").toEqual(before);
		expect(readdirSync(stagingOf(into))).toEqual([]);
	});

	it("removes a pipe planted at a name it places, and places over a file larger than the share takes, copying neither aside", async () => {
		const into = join(folder(made, "scratch"), QUEST, "handover", "kestrel");
		mkdirSync(into, { recursive: true });
		const pipe = join(into, "a.bundle");
		expect(spawnSync("mkfifo", [pipe]).status, "a pipe is made").toBe(0);
		// Sparse, so it takes no room here, but a copy would write it whole.
		writeFileSync(join(into, "b.bundle"), "");
		truncateSync(join(into, "b.bundle"), SHARE_LARGEST_FILE + 1);

		await staged(into, "s-v", async (stage) => {
			writeFileSync(join(stage.folder, "a.bundle"), "new a\n");
			writeFileSync(join(stage.folder, "b.bundle"), "new b\n");
			stage.place(["a.bundle", "b.bundle"]);
		});

		expect(lstatSync(pipe).isFile(), "a file now, not the pipe").toBe(true);
		expect(filesIn(into)).toEqual({
			"a.bundle": Buffer.from("new a\n"),
			"b.bundle": Buffer.from("new b\n"),
		});
		expect(readdirSync(stagingOf(into)), "its staging folder is gone").toEqual(
			[],
		);
	});

	it("keeps a larger session log an earlier carry left until the carry that drops it stands", async () => {
		const into = join(folder(made, "scratch"), QUEST, "handover", "kestrel");
		mkdirSync(into, { recursive: true });
		const old = join(into, "2026-11-25_s-v.jsonl");
		// As a harness that never gzipped left it: sparse here, whole if copied.
		writeFileSync(old, "");
		truncateSync(old, SHARE_LARGEST_FILE + 1);
		const carry = (fails: boolean) =>
			staged(into, "s-v", async (stage) => {
				writeFileSync(join(stage.folder, "a.bundle"), "new a\n");
				stage.place(["a.bundle"], ["2026-11-25_s-v.jsonl"]);
				if (fails) throw new Error("the disk is full");
			});

		await expect(carry(true)).rejects.toThrow("the disk is full");

		expect(statSync(old).size, "a failed carry leaves it").toBe(
			SHARE_LARGEST_FILE + 1,
		);

		await carry(false);

		expect(readdirSync(into), "a carry that stands drops it").toEqual([
			"a.bundle",
		]);
		expect(readdirSync(stagingOf(into))).toEqual([]);
	});

	it("moves nothing more through a handover swapped for a link between two moves", async () => {
		const into = join(folder(made, "scratch"), QUEST, "handover", "kestrel");
		mkdirSync(into, { recursive: true });
		writeFileSync(join(into, "a.bundle"), "earlier a\n");
		writeFileSync(join(into, "b.bundle"), "earlier b\n");
		const outside = folder(made, "outside");
		writeFileSync(join(outside, "b.bundle"), "not the carry's\n");
		// A fenced command swaps the handover once the first has moved aside.
		afterUnlink.set(join(into, "a.bundle"), () => {
			renameSync(into, `${into}-was`);
			symlinkSync(outside, into);
		});

		await expect(
			staged(into, "s-v", async (stage) => {
				writeFileSync(join(stage.folder, "a.bundle"), "new a\n");
				writeFileSync(join(stage.folder, "b.bundle"), "new b\n");
				stage.place(["a.bundle", "b.bundle"]);
			}),
		).rejects.toThrow("is a link");

		expect(readdirSync(outside), "nothing outside is placed").toEqual([
			"b.bundle",
		]);
		expect(readFileSync(join(outside, "b.bundle"), "utf8")).toBe(
			"not the carry's\n",
		);
	});
});
