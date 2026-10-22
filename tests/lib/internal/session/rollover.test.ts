/**
 * Rolling a session over: the fresh log gives pi the same context and
 * every extension the same state, leaves the rest in the parent, and
 * the parent stays readable from the fresh log.
 */

import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ancestry,
	carriedBy,
	type Entry,
	ROLLOVER_RECORD,
	recordIndex,
	rolledFrom,
	rollOver,
	sessionFileName,
	uuidv7,
	writeRolled,
} from "../../../../lib/internal/session/rollover.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rollover-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const user = (text: string) => ({
	role: "user" as const,
	content: text,
	timestamp: Date.now(),
});

const assistant = (text: string, cost = 0.25) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	},
	stopReason: "stop" as const,
	timestamp: Date.now(),
});

/**
 * A session with history before a compaction and a kept tail after
 * it, the shape a long session has, written to disk by pi itself.
 */
function longSession(): {
	manager: SessionManager;
	ids: Record<string, string>;
} {
	const manager = SessionManager.create(dir, dir);
	const ids: Record<string, string> = {};
	manager.appendModelChange("anthropic", "claude");
	ids.state = manager.appendCustomEntry("quest-workflow", { questId: "Q1" });
	ids.early = manager.appendMessage(user("early question"));
	manager.appendMessage(assistant("early answer"));
	ids.earlyLabel = manager.appendLabelChange(ids.early, "start");
	manager.appendThinkingLevelChange("high");
	ids.kept = manager.appendMessage(user("kept question"));
	manager.appendMessage(assistant("kept answer"));
	ids.keptLabel = manager.appendLabelChange(ids.kept, "kept");
	ids.compaction = manager.appendCompaction(
		"what happened early",
		ids.kept,
		1000,
	);
	manager.appendCustomEntry("away-state", { away: false });
	manager.appendMessage(user("after"));
	manager.appendMessage(assistant("after answer"));
	return { manager, ids };
}

function branchOf(manager: SessionManager): Entry[] {
	return manager.getBranch() as unknown as Entry[];
}

/** Roll a session over into `dir` and open the fresh log as pi would. */
function rolledInto(manager: SessionManager, carried = {}) {
	const rolled = rollOver(branchOf(manager), {
		parentSession: manager.getSessionFile() ?? "",
		cwd: manager.getCwd(),
		version: manager.getHeader()?.version,
		carried,
	});
	if (!rolled) throw new Error("expected a rollover");
	const path = writeRolled(dir, rolled);
	return { rolled, path, fresh: SessionManager.open(path) };
}

describe("a rolled-over log", () => {
	it("gives pi the same context, model and thinking level", () => {
		const { manager } = longSession();
		const { fresh } = rolledInto(manager);

		expect(fresh.buildSessionContext()).toEqual(manager.buildSessionContext());
	});

	it("keeps every extension's state in its order", () => {
		const { manager } = longSession();
		const { fresh } = rolledInto(manager);
		const custom = (entries: readonly unknown[]) =>
			(entries as Entry[])
				.filter((e) => e.type === "custom" && e.customType !== ROLLOVER_RECORD)
				.map((e) => [e.customType, e.data]);

		expect(custom(fresh.getBranch())).toEqual(custom(manager.getBranch()));
	});

	it("leaves the summarised conversation, and labels on it, in the parent", () => {
		const { manager, ids } = longSession();
		const { fresh } = rolledInto(manager);
		const freshIds = fresh.getBranch().map((e) => e.id);

		expect(freshIds).not.toContain(ids.early);
		expect(freshIds).not.toContain(ids.earlyLabel);
		expect(freshIds).toContain(ids.kept);
		expect(freshIds).toContain(ids.keptLabel);
		expect(fresh.getLabel(ids.kept)).toBe("kept");
	});

	it("drops a later label on summarised conversation, which pi could not show", () => {
		const { manager, ids } = longSession();
		const late = manager.appendLabelChange(ids.early, "late");
		const { fresh } = rolledInto(manager);

		expect(fresh.getBranch().map((e) => e.id)).not.toContain(late);
	});

	it("names its parent in its header and ends with the record", () => {
		const { manager } = longSession();
		const parent = manager.getSessionFile();
		const leaf = manager.getLeafId();
		const { fresh } = rolledInto(manager, { "cost-workflow": { spend: 3 } });
		const branch = fresh.getBranch();

		expect(fresh.getHeader()?.parentSession).toBe(parent);
		expect(recordIndex(branch)).toBe(branch.length - 1);
		expect(rolledFrom(branch)).toMatchObject({
			parentSession: parent,
			parentLeaf: leaf,
		});
		expect(carriedBy(branch, "cost-workflow")).toEqual({ spend: 3 });
	});

	it("starts at the compaction itself when the compaction kept nothing", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(user("question"));
		manager.appendMessage(assistant("answer"));
		const compaction = manager.appendCompaction("all of it", null, 10);
		manager.appendMessage(user("next"));
		manager.appendMessage(assistant("next answer"));
		const { fresh } = rolledInto(manager);

		expect(fresh.getBranch()[0]?.id).toBe(compaction);
		expect(fresh.buildSessionContext()).toEqual(manager.buildSessionContext());
	});

	it("carries no record of an earlier rollover but its own", () => {
		const { manager } = longSession();
		const first = rolledInto(manager).fresh;
		first.appendMessage(user("more"));
		first.appendMessage(assistant("more answer"));
		const kept = first.getLeafId();
		first.appendCompaction("again", kept, 10);
		const second = rolledInto(first).fresh;
		const records = second
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === ROLLOVER_RECORD);

		expect(records).toHaveLength(1);
		expect(rolledFrom(second.getBranch())?.parentSession).toBe(
			first.getSessionFile(),
		);
	});
});

describe("what does not roll over", () => {
	it("a branch with no compaction", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(user("question"));
		manager.appendMessage(assistant("answer"));

		expect(
			rollOver(branchOf(manager), { parentSession: "p", cwd: dir }),
		).toBeUndefined();
	});

	it("a compaction whose first kept entry the branch does not hold", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(user("question"));
		manager.appendMessage(assistant("answer"));
		manager.appendCompaction("summary", "nowhere", 10);

		expect(
			rollOver(branchOf(manager), { parentSession: "p", cwd: dir }),
		).toBeUndefined();
	});
});

describe("the parent logs", () => {
	it("read back oldest first, without what the fresh log carried", () => {
		const { manager, ids } = longSession();
		const first = rolledInto(manager).fresh;
		first.appendMessage(user("in the middle"));
		const middle = first.appendMessage(assistant("middle answer"));
		first.appendCompaction("again", middle, 10);
		const second = rolledInto(first).fresh;
		const older = ancestry(second.getBranch()).map((e) => e.id);
		const all = [...older, ...second.getBranch().map((e) => e.id)];

		// The state before it was carried, so the oldest conversation leads.
		expect(older[0]).toBe(ids.early);
		expect(new Set(all).size).toBe(all.length);
		for (const entry of manager.getBranch()) expect(all).toContain(entry.id);
	});

	it("end where a parent is gone from disk", () => {
		const { manager } = longSession();
		const { fresh } = rolledInto(manager);
		rmSync(manager.getSessionFile() ?? "");

		expect(ancestry(fresh.getBranch())).toEqual([]);
	});

	it("are not read for a log that never rolled over", () => {
		const { manager } = longSession();
		const read = () => {
			throw new Error("read a parent");
		};

		expect(ancestry(manager.getBranch(), read)).toEqual([]);
	});
});

describe("the fresh log on disk", () => {
	it("is written whole, with no partial file left", () => {
		const { manager } = longSession();
		const { path, rolled } = rolledInto(manager);
		const lines = readFileSync(path, "utf8").trim().split("\n");

		expect(lines).toHaveLength(rolled.entries.length + 1);
		expect(JSON.parse(lines[0] ?? "{}").type).toBe("session");
		expect(readdirSync(dir).some((name) => name.endsWith(".partial"))).toBe(
			false,
		);
		expect(existsSync(path)).toBe(true);
	});

	it("is named the way pi names a log", () => {
		const at = new Date("2026-10-22T05:56:42.236Z");
		const id = uuidv7(at.getTime());

		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(id.replace(/-/g, "").slice(0, 12)).toBe(
			at.getTime().toString(16).padStart(12, "0"),
		);
		expect(sessionFileName(id, at)).toBe(
			`2026-10-22T05-56-42-236Z_${id}.jsonl`,
		);
	});
});
