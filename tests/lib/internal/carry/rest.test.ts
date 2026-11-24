/**
 * What `pi-carry` carries of a quest once its steered sessions have
 * carried their own, through real git.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

/** A session file for `id`, as pi keeps one, with `messages` after its header. */
function sessionFile(id: string, messages = 0): string {
	const file = join(folder(made, "sessions"), `2026-11-07_${id}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", id })}\n${'{"type":"message"}\n'.repeat(messages)}`,
	);
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

async function carry(
	home: string,
	into: string,
	here: QuestHere,
	largestFile?: number,
) {
	const said: RestLine[] = [];
	const whole = await carryRest({
		exec,
		into,
		home,
		here,
		say: (line) => said.push(line),
		...(largestFile === undefined ? {} : { largestFile }),
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
		await git(trees.stuck ?? "", "remote", "remove", "origin");

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
		const failed = said.at(-1);
		expect(failed?.kind, "mycelium reads why from a failed line").toBe(
			"failed",
		);
		expect(
			failed?.kind === "failed" ? failed.why : "",
			"it names the tree and why",
		).toContain(`${trees.stuck}: `);
	});

	it("carries again a session whose earlier done file names a file too large to share, gzipped", async () => {
		const { home, trees, into } = await homeWith("app");
		const file = sessionFile("s-big", 500);
		const session = { id: "s-big", cwd: trees.app ?? "", file };
		// As a harness that never gzipped left it: the whole log, as it is.
		await carryAway({
			exec,
			into,
			home,
			quest: QUEST,
			session,
			trees: [trees.app ?? ""],
			largestFile: Number.MAX_SAFE_INTEGER,
		});

		const { whole } = await carry(
			home,
			into,
			questHere({
				resting: [session],
				held: [{ path: trees.app ?? "", sessions: ["s-big"] }],
			}),
			1000,
		);

		expect(whole, "it went whole").toBe(true);
		expect(readHandover(join(into, "s-big.done.json"))).toMatchObject({
			sessionFile: "2026-11-07_s-big.jsonl.gz",
			trees: [{ path: "~/src/app" }],
		});
		expect(
			existsSync(join(into, "2026-11-07_s-big.jsonl")),
			"the copy the share refused is gone",
		).toBe(false);
	});

	it("refuses a session whose file is too large even gzipped, saying why, and carries its trees under nobody else", async () => {
		const { home, trees, into } = await homeWith("app");
		const file = sessionFile("s-huge", 500);

		const { whole, said } = await carry(
			home,
			into,
			questHere({
				resting: [{ id: "s-huge", cwd: trees.app ?? "", file }],
				held: [{ path: trees.app ?? "", sessions: ["s-huge"] }],
				trees: [trees.app ?? ""],
			}),
			50,
		);

		expect(whole, "a refused session is not whole").toBe(false);
		expect(said).toContainEqual({ kind: "done", files: [] });
		const failed = said.at(-1);
		expect(failed?.kind === "failed" ? failed.why : "").toMatch(
			/session s-huge: .*still over the 0\.0 MiB the share carries/,
		);
		expect(existsSync(join(into, "s-huge.done.json"))).toBe(false);
		expect(existsSync(join(into, `${QUEST}.done.json`))).toBe(false);
	});

	it("refuses a quest's own tree whose bundle is larger than the share carries", async () => {
		const { home, trees, into } = await homeWith("big");
		await git(trees.big ?? "", "checkout", "-q", "-b", "wide");
		await commit(trees.big ?? "", "big.txt", "unpushed\n".repeat(400));

		const { whole, said } = await carry(
			home,
			into,
			questHere({ trees: [trees.big ?? ""] }),
			200,
		);

		expect(whole).toBe(false);
		const failed = said.at(-1);
		expect(failed?.kind === "failed" ? failed.why : "").toMatch(
			/\.bundle is \d+ bytes, over the 200 bytes the share carries/,
		);
		expect(existsSync(join(into, `${QUEST}.done.json`))).toBe(false);
	});

	it("says a failed line when the quest's own carry throws, leaving what stood there", async () => {
		const { home, trees, into } = await homeWith("app");
		const held = join(into, `${QUEST}.done.json`);
		mkdirSync(held, { recursive: true });

		const { whole, said } = await carry(
			home,
			into,
			questHere({ trees: [trees.app ?? ""] }),
		);

		expect(whole).toBe(false);
		expect(said).toContainEqual({ kind: "done", files: [] });
		const failed = said.at(-1);
		expect(failed?.kind === "failed" ? failed.why : "").toMatch(
			/^one thing was refused, so the carry isn't whole: the quest's own trees: /,
		);
		expect(existsSync(held), "the folder in its way stays").toBe(true);
	});

	it("keeps the quest's earlier carry when its next refuses a tree, saying the other was held back with it", async () => {
		const { home, trees, into } = await homeWith("app", "lib");
		await git(trees.lib ?? "", "checkout", "-q", "-b", "side");
		await commit(trees.lib ?? "", "side.txt", "unpushed\n");
		const here = questHere({ trees: [trees.lib ?? "", trees.app ?? ""] });
		await carry(home, into, here);
		const done = join(into, `${QUEST}.done.json`);
		const before = readHandover(done);
		// Too random to pack small, so its bundle alone passes the limit.
		await commit(
			trees.app ?? "",
			"big.txt",
			randomBytes(8000).toString("base64"),
		);

		const { whole, said } = await carry(home, into, here, 4000);

		expect(whole).toBe(false);
		expect(readHandover(done), "its earlier done file, as it was").toEqual(
			before,
		);
		expect(said).toContainEqual({ kind: "done", files: [] });
		expect(said).toContainEqual(
			expect.objectContaining({
				kind: "tree",
				path: trees.lib,
				did: "refused",
				why: expect.stringMatching(/^held back, since .* was refused/),
			}),
		);
		const failed = said.at(-1);
		expect(failed?.kind === "failed" ? failed.why : "").toMatch(
			/its earlier carry stays as it was/,
		);
	});

	it("says no failed line when every tree went", async () => {
		const { home, trees, into } = await homeWith("fine");

		const { said } = await carry(
			home,
			into,
			questHere({ trees: [trees.fine ?? ""] }),
		);

		expect(said.some((line) => line.kind === "failed")).toBe(false);
	});
});
