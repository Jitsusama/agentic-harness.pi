import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { defaultWorkspaceRoot } from "../../../extensions/quest-workflow/workspace";
import { ensureQuestScratchDir } from "../../../lib/internal/quest/scratch";

let root: string;
let savedCache: string | undefined;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}

function fakeCtx(cwd: string) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bulk-conclude-"));
	savedCache = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = join(root, "cache");
});

afterEach(() => {
	if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = savedCache;
	rmSync(root, { recursive: true, force: true });
});

async function twoQuests() {
	const state = createQuestState({ questsRoot: join(root, "quests") });
	const ids: string[] = [];
	for (const title of ["First Sweep", "Second Sweep"]) {
		const created = await handle(state, fakePi(), fakeCtx(root), {
			action: "create",
			title,
		});
		if (!created.ok) throw new Error(created.guidance);
		ids.push(state.questId ?? "");
	}
	const workspace = (id: string, rel: string) =>
		join(defaultWorkspaceRoot(), id, rel);
	for (const id of ids) {
		for (const rel of ["tmp/run.log", "lab/results.csv"]) {
			mkdirSync(join(workspace(id, rel), ".."), { recursive: true });
			writeFileSync(workspace(id, rel), "x\n");
		}
	}
	const sweep = (action: "conclude" | "retire") =>
		handle(state, fakePi(), fakeCtx(root), {
			action,
			id: ids.join(","),
			reason: "swept",
		});
	return { state, ids, workspace, sweep };
}

async function batch(size: number) {
	const state = createQuestState({ questsRoot: join(root, "quests") });
	const ids: string[] = [];
	for (let n = 0; n < size; n++) {
		const created = await handle(state, fakePi(), fakeCtx(root), {
			action: "create",
			title: `Batch Quest ${n}`,
		});
		if (!created.ok) throw new Error(created.guidance);
		ids.push(state.questId ?? "");
	}
	const dir = (n: number) => join(state.questsRoot, ids[n] ?? "");
	const put = (n: number, rel: string) => {
		mkdirSync(join(dir(n), rel, ".."), { recursive: true });
		writeFileSync(join(dir(n), rel), "x\n");
	};
	const status = (n: number) =>
		/^status: (\S+)$/m.exec(
			readFileSync(join(dir(n), "README.md"), "utf8"),
		)?.[1];
	const sweep = (
		action: "conclude" | "retire" | "undo",
		extra: Record<string, unknown> = {},
	) =>
		handle(state, fakePi(), fakeCtx(root), {
			action,
			...(action === "undo" ? {} : { id: ids.join(","), reason: "swept" }),
			...extra,
		});
	return { state, ids, put, status, sweep };
}

describe("sweeping quests by id", () => {
	for (const action of ["conclude", "retire"] as const) {
		it(`clears each quest's workspace tmp/ on ${action}, keeping the rest`, async () => {
			const { state, ids, workspace, sweep } = await twoQuests();
			const result = await sweep(action);
			expect(result.ok).toBe(true);
			for (const id of ids) {
				expect(existsSync(workspace(id, "tmp"))).toBe(false);
				expect(existsSync(workspace(id, "lab/results.csv"))).toBe(true);
				const readme = readFileSync(
					join(state.questsRoot, id, "README.md"),
					"utf8",
				);
				expect(readme).toContain("Cleared the workspace's tmp/ folder.");
			}
		});
	}

	it("concludes the whole records and skips the rest, saying what to fix", async () => {
		const { status, put, sweep } = await batch(4);
		put(1, "lab/results.csv");
		put(3, "notes.txt");
		const result = await sweep("conclude");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect([0, 1, 2, 3].map(status)).toEqual([
			"concluded",
			"active",
			"concluded",
			"active",
		]);
		expect(result.message).toContain("Concluded 2 quests.");
		expect(result.message).toContain("Skipped 2");
		expect(result.message).toMatch(
			/QEST-[^:]+:\n- lab is not part of the record/,
		);
		expect(result.message).toContain("- notes.txt is not part of the record");
	});

	it("refuses a batch with no whole record, changing nothing", async () => {
		const { status, put, sweep } = await batch(2);
		put(0, "lab/results.csv");
		put(1, "lab/results.csv");
		const result = await sweep("conclude");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.guidance).toContain("nothing was concluded");
		expect([0, 1].map(status)).toEqual(["active", "active"]);
	});

	it("names what a dry run would skip and changes nothing", async () => {
		const { status, put, sweep } = await batch(2);
		put(1, "lab/results.csv");
		const result = await sweep("conclude", { dryRun: true });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.message).toContain("would conclude 1 quest");
		expect(result.message).toContain("Would skip 1 quest");
		expect([0, 1].map(status)).toEqual(["active", "active"]);
	});

	it("retires untidy records as they stand", async () => {
		const { status, put, sweep } = await batch(2);
		put(1, "lab/results.csv");
		const result = await sweep("retire");
		expect(result.ok).toBe(true);
		expect([0, 1].map(status)).toEqual(["retired", "retired"]);
	});

	it("undoes only the quests the batch concluded", async () => {
		const { status, put, sweep } = await batch(3);
		put(1, "lab/results.csv");
		await sweep("conclude");
		const undone = await sweep("undo");
		expect(undone.ok).toBe(true);
		expect([0, 1, 2].map(status)).toEqual(["active", "active", "active"]);
	});

	it("holds a single quest named by id to the same audit", async () => {
		const { state, ids, status, put } = await batch(2);
		put(0, "lab/results.csv");
		const result = await handle(state, fakePi(), fakeCtx(root), {
			action: "conclude",
			id: ids[0],
		});
		expect(result.ok).toBe(false);
		expect(status(0)).toBe("active");
	});

	it("reaps the scratch each quest recorded before workspaces", async () => {
		const { state, ids, sweep } = await twoQuests();
		const scratch = ids.map((id) =>
			ensureQuestScratchDir(join(state.questsRoot, id), id, null),
		);
		const result = await sweep("conclude");
		expect(result.ok).toBe(true);
		for (const [i, id] of ids.entries()) {
			expect(existsSync(scratch[i] ?? "")).toBe(false);
			const readme = readFileSync(
				join(state.questsRoot, id, "README.md"),
				"utf8",
			);
			expect(readme).not.toContain("scratchDir");
		}
	});
});
