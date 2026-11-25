/**
 * Rolling a session over: the fresh log gives pi the same context and
 * every extension the same state, leaves the rest in the parent, and
 * the parent stays readable from the fresh log.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askedBy } from "../../../../lib/internal/logs/recall.ts";
import { markedOnDisk } from "../../../../lib/internal/logs/recall-on-disk.ts";
import {
	carriedBy,
	diskFinds,
	type Entry,
	leaveInParentLog,
	logLines,
	messagesOnDisk,
	messagesOnDiskAsync,
	ROLLOVER_RECORD,
	recordIndex,
	rolledFrom,
	rollOver,
	rolloverAsked,
	sessionFileName,
	writeRolled,
} from "../../../../lib/internal/session/rollover.ts";
import { uuidv7 } from "../../../../lib/internal/session/uuidv7.ts";

/** How much of a parent log the reader takes at once, as rollover.ts reads it. */
const CHUNK_BYTES = 1024 * 1024;

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
	ids: LongSessionIds;
} {
	const manager = SessionManager.create(dir, dir);
	manager.appendModelChange("anthropic", "claude");
	const state = manager.appendCustomEntry("quest-workflow", {
		questId: "Q1",
	});
	const early = manager.appendMessage(user("early question"));
	manager.appendMessage(assistant("early answer"));
	const earlyLabel = manager.appendLabelChange(early, "start");
	manager.appendThinkingLevelChange("high");
	const kept = manager.appendMessage(user("kept question"));
	manager.appendMessage(assistant("kept answer"));
	const keptLabel = manager.appendLabelChange(kept, "kept");
	const compaction = manager.appendCompaction(
		"what happened early",
		kept,
		1000,
	);
	manager.appendCustomEntry("away-state", { away: false });
	manager.appendMessage(user("after"));
	manager.appendMessage(assistant("after answer"));
	return {
		manager,
		ids: { state, early, earlyLabel, kept, keptLabel, compaction },
	};
}

/** The ids of the entries in a long session that the tests look for. */
interface LongSessionIds {
	state: string;
	early: string;
	earlyLabel: string;
	kept: string;
	keptLabel: string;
	compaction: string;
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

	it("leaves a record nobody reads back in the parent, keeping the one after the compaction", () => {
		const { manager, ids } = longSession();
		const before = manager.appendCustomEntry("a-report", { n: 1 });
		const next = manager.appendMessage(user("next"));
		manager.appendCompaction("again", next, 10);
		const after = manager.appendCustomEntry("a-report", { n: 2 });
		const rolled = rollOver(branchOf(manager), {
			parentSession: manager.getSessionFile() ?? "",
			cwd: manager.getCwd(),
			leftBehind: new Set(["a-report"]),
		});
		const freshIds = rolled?.entries.map((e) => e.id);

		expect(freshIds).not.toContain(before);
		expect(freshIds).toContain(after);
		expect(freshIds).toContain(ids.state);
	});

	it("leaves behind what an owner named with leaveInParentLog", () => {
		const { manager } = longSession();
		const record = manager.appendCustomEntry("rollover-test-record", {});
		const next = manager.appendMessage(user("next"));
		manager.appendCompaction("again", next, 10);
		leaveInParentLog("rollover-test-record");
		const { fresh } = rolledInto(manager);

		expect(fresh.getBranch().map((e) => e.id)).not.toContain(record);
		expect(fresh.buildSessionContext()).toEqual(manager.buildSessionContext());
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

describe("whether a session is asked to roll over", () => {
	const ask = (lines: string | undefined, env: NodeJS.ProcessEnv = {}) => {
		const path = join(dir, "switch");
		if (lines !== undefined) writeFileSync(path, lines);
		return (id: string) => rolloverAsked(id, env, path);
	};

	it("stays off with no switch and nothing in the environment", () => {
		expect(ask(undefined)("s1")).toBe("off");
		expect(ask("\n")("s1")).toBe("off");
	});

	it("waits for a large log when the environment or a line turns it on", () => {
		expect(ask(undefined, { PI_ROLLOVER: "on" })("s1")).toBe("large");
		expect(ask("on\n")("s1")).toBe("large");
	});

	it("rolls a named session over now, even where the environment turns it on", () => {
		const asked = ask(" s1 \ns2\n", { PI_ROLLOVER: "on" });
		expect(asked("s1")).toBe("now");
		expect(asked("s2")).toBe("now");
		expect(asked("s3")).toBe("large");
		expect(asked("")).toBe("large");
	});

	it("stays off where the environment turns it off, whatever the switch says", () => {
		expect(ask("on\ns1\n", { PI_ROLLOVER: "off" })("s1")).toBe("off");
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

/** What recall reads of the logs `branch` rolled over from, by id. */
function readByRecall(
	branch: readonly unknown[],
	lines?: Parameters<typeof markedOnDisk>[2],
): string[] {
	return markedOnDisk(branch, askedBy({ query: "answer" }), lines).marked.map(
		(mark) => mark.id,
	);
}

describe("the parent logs, as recall reads them", () => {
	it("read back oldest first, without what the fresh log carried", () => {
		const { manager, ids } = longSession();
		const first = rolledInto(manager).fresh;
		first.appendMessage(user("in the middle"));
		const middle = first.appendMessage(assistant("middle answer"));
		first.appendCompaction("again", middle, 10);
		const second = rolledInto(first).fresh;
		const older = readByRecall(second.getBranch());
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

		expect(readByRecall(fresh.getBranch())).toEqual([]);
	});

	it("are not read for a log that never rolled over", () => {
		const { manager } = longSession();
		const read = (): Iterable<string> => {
			throw new Error("read a parent");
		};

		expect(readByRecall(manager.getBranch(), read)).toEqual([]);
	});
});

describe("messages asked of the parent logs", () => {
	it("are read from every parent, oldest first, and only the messages asked for", () => {
		const { manager, ids } = longSession();
		const first = rolledInto(manager).fresh;
		const middle = first.appendMessage(user("in the middle"));
		const middleAnswer = first.appendMessage(assistant("middle answer"));
		first.appendCompaction("again", middleAnswer, 10);
		const second = rolledInto(first).fresh;

		const read = messagesOnDisk(
			second.getBranch(),
			// The label stays on disk too, but is not a message.
			new Set([middle, ids.early, ids.earlyLabel]),
		);

		expect(read.map((entry) => entry.id)).toEqual([ids.early, middle]);
		expect(texts(read)).toEqual(["early question", "in the middle"]);
	});

	it("leave out what the branch already holds", () => {
		const { manager, ids } = longSession();
		const { fresh } = rolledInto(manager);

		const read = messagesOnDisk(
			fresh.getBranch(),
			new Set([ids.early, ids.kept]),
		);

		expect(read.map((entry) => entry.id)).toEqual([ids.early]);
	});

	it("end where a parent is gone from disk, keeping what the nearer ones hold", () => {
		const { manager, ids } = longSession();
		const first = rolledInto(manager).fresh;
		const middle = first.appendMessage(user("in the middle"));
		const middleAnswer = first.appendMessage(assistant("middle answer"));
		first.appendCompaction("again", middleAnswer, 10);
		const second = rolledInto(first).fresh;
		rmSync(manager.getSessionFile() ?? "");

		const read = messagesOnDisk(
			second.getBranch(),
			new Set([middle, ids.early]),
		);

		expect(read.map((entry) => entry.id)).toEqual([middle]);
	});

	it("end where a parent is not a regular file, rather than wait on it", () => {
		const { manager, ids } = longSession();
		const { fresh } = rolledInto(manager);
		const file = manager.getSessionFile() ?? "";
		const log = readFileSync(file);
		rmSync(file);
		execFileSync("mkfifo", [file]);
		// The pipe already holds the whole log and stays open for writing, so a
		// reader that took it would find the message, and none can block.
		const pipe = openSync(file, constants.O_RDWR | constants.O_NONBLOCK);
		try {
			expect(writeSync(pipe, log)).toBe(log.length);
			expect(messagesOnDisk(fresh.getBranch(), new Set([ids.early]))).toEqual(
				[],
			);
		} finally {
			closeSync(pipe);
		}
	});

	it("are read from a line pi wrote in another order", () => {
		const { manager, ids } = longSession();
		const file = manager.getSessionFile() ?? "";
		const reordered = readFileSync(file, "utf8")
			.split("\n")
			.map((line) => {
				if (line.trim() === "") return line;
				const { type, ...rest } = JSON.parse(line) as { type: string };
				return JSON.stringify({ ...rest, type });
			})
			.join("\n");
		writeFileSync(file, reordered);
		const { fresh } = rolledInto(SessionManager.open(file));

		const read = messagesOnDisk(fresh.getBranch(), new Set([ids.early]));

		expect(texts(read)).toEqual(["early question"]);
	});

	it("are read whole from lines longer than a chunk, letters of every width", () => {
		const { manager, ids } = longSession();
		// Past two chunks, of letters two, four and one bytes wide.
		const long = "é🌲a".repeat(300_000);
		const first = manager.appendMessage(user(long));
		const second = manager.appendMessage(user(`${long}ü`));
		const kept = manager.appendMessage(user("kept after the long lines"));
		manager.appendCompaction("long lines", kept, 10);
		const { fresh } = rolledInto(manager);

		const read = messagesOnDisk(
			fresh.getBranch(),
			new Set([ids.early, first, second]),
		);

		expect(read.map((entry) => entry.id)).toEqual([ids.early, first, second]);
		expect(texts(read)).toEqual(["early question", long, `${long}ü`]);
	});

	it("are read again from lines longer than a chunk, where they start", () => {
		const { manager, ids } = longSession();
		const long = "é🌲a".repeat(300_000);
		const first = manager.appendMessage(user(long));
		const second = manager.appendMessage(user(`${long}ü`));
		const kept = manager.appendMessage(user("kept after the long lines"));
		manager.appendCompaction("long lines", kept, 10);
		const branch = rolledInto(manager).fresh.getBranch();
		const wanted = new Set([ids.early, first, second]);
		const finds = diskFinds();
		messagesOnDisk(branch, wanted, finds);

		const read = messagesOnDisk(branch, wanted, finds);

		expect(texts(read)).toEqual(["early question", long, `${long}ü`]);
		expect(finds.scanned).toBe(1);
	});

	it("are read whole where a chunk ends inside a letter", () => {
		const { manager } = longSession();
		const { fresh } = rolledInto(manager);
		const file = manager.getSessionFile() ?? "";
		const text = "🌲".repeat(600_000);
		const head =
			'{"type":"message","id":"split","parentId":null,"timestamp":"","message":{"role":"user","content":"';
		const filler = (n: number) =>
			`{"type":"custom","customType":"filler","data":"${"x".repeat(n)}"}\n`;
		// Filler enough that each chunk's end falls one byte into a letter.
		const before = Buffer.byteLength(filler(0) + head);
		writeFileSync(
			file,
			`${filler((CHUNK_BYTES - before - 1) % 4)}${head}${text}"}}\n`,
		);

		const read = messagesOnDisk(fresh.getBranch(), new Set(["split"]));

		// The first byte of the second chunk carries on a letter.
		expect((readFileSync(file)[CHUNK_BYTES] ?? 0) & 0xc0).toBe(0x80);
		expect(texts(read)).toEqual([text]);
	});

	it("are not read for a log that never rolled over", () => {
		const { manager, ids } = longSession();

		expect(messagesOnDisk(manager.getBranch(), new Set([ids.early]))).toEqual(
			[],
		);
	});

	it("are found by their bytes, so no other line of a parent is parsed", () => {
		const { manager, ids } = longSession();
		// The answer, so the scan passes the question, a message not asked
		// for, before it finds what it wants and stops.
		const answer = manager
			.getBranch()
			.find((entry) => entry.parentId === ids.early)?.id;
		const branch = rolledInto(manager).fresh.getBranch();
		const parse = vi.spyOn(JSON, "parse");
		try {
			const read = messagesOnDisk(branch, new Set([answer ?? ""]));

			expect(answer).toBeDefined();
			expect(read.map((entry) => entry.id)).toEqual([answer]);
			expect(parse).toHaveBeenCalledTimes(1);
		} finally {
			parse.mockRestore();
		}
	});

	it("are read again straight from the lines found before, with no scan", () => {
		const { manager, ids } = longSession();
		const branch = rolledInto(manager).fresh.getBranch();
		const finds = diskFinds();
		messagesOnDisk(branch, new Set([ids.early]), finds);
		const parse = vi.spyOn(JSON, "parse");
		try {
			const read = messagesOnDisk(branch, new Set([ids.early]), finds);

			expect(texts(read)).toEqual(["early question"]);
			expect(finds.scanned).toBe(1);
			expect(parse).toHaveBeenCalledTimes(1);
		} finally {
			parse.mockRestore();
		}
	});

	it("are not looked for again once no parent held them", () => {
		const { manager } = longSession();
		const branch = rolledInto(manager).fresh.getBranch();
		const finds = diskFinds();
		messagesOnDisk(branch, new Set(["nowhere"]), finds);
		const parse = vi.spyOn(JSON, "parse");
		try {
			expect(messagesOnDisk(branch, new Set(["nowhere"]), finds)).toEqual([]);
			expect(finds.scanned).toBe(1);
			expect(parse).not.toHaveBeenCalled();
		} finally {
			parse.mockRestore();
		}
	});

	it("are looked for afresh when the line found before holds another message", () => {
		const { manager } = longSession();
		const said = manager.appendMessage(user("first said"));
		const other = manager.appendMessage(user("other said"));
		const kept = manager.appendMessage(user("kept after them"));
		manager.appendCompaction("two of a size", kept, 10);
		const branch = rolledInto(manager).fresh.getBranch();
		const finds = diskFinds();
		messagesOnDisk(branch, new Set([said]), finds);
		// The two lines change places, so where `said` was, `other` is.
		const file = manager.getSessionFile() ?? "";
		const lines = readFileSync(file, "utf8").split("\n");
		const at = lines.findIndex((line) => line.includes(`"id":"${said}"`));
		const saidLine = lines[at] ?? "";
		const otherLine = lines[at + 1] ?? "";
		expect(otherLine).toContain(`"id":"${other}"`);
		expect(otherLine.length).toBe(saidLine.length);
		lines.splice(at, 2, otherLine, saidLine);
		writeFileSync(file, lines.join("\n"));

		const read = messagesOnDisk(branch, new Set([said]), finds);

		expect(read.map((entry) => entry.id)).toEqual([said]);
		expect(texts(read)).toEqual(["first said"]);
		expect(finds.scanned).toBe(2);
	});

	it("start over what they know when the branch carries on from another log", () => {
		const one = rolledInto(longSession().manager).fresh.getBranch();
		const { manager, ids } = longSession();
		const two = rolledInto(manager).fresh.getBranch();
		const finds = diskFinds();
		// The first log's parents hold none of the second's messages.
		expect(messagesOnDisk(one, new Set([ids.early]), finds)).toEqual([]);

		const read = messagesOnDisk(two, new Set([ids.early]), finds);

		expect(texts(read)).toEqual(["early question"]);
	});

	it("give the event loop back while they read a large parent", async () => {
		const { manager, ids } = longSession();
		const { fresh } = withFillerBefore(manager);
		const order: string[] = [];
		setImmediate(() => order.push("loop"));

		const read = await messagesOnDiskAsync(
			fresh.getBranch(),
			new Set([ids.early]),
		);
		order.push("read");

		expect(order).toEqual(["loop", "read"]);
		expect(read.map((entry) => entry.id)).toEqual([ids.early]);
	});

	it("stop giving anything back once their reader is aborted", async () => {
		const { manager, ids } = longSession();
		const { fresh } = withFillerBefore(manager);
		const controller = new AbortController();
		controller.abort();

		const read = await messagesOnDiskAsync(
			fresh.getBranch(),
			new Set([ids.early]),
			{ signal: controller.signal },
		);

		expect(read).toEqual([]);
	});

	it("stop partway once their reader is aborted during the scan, marking nothing", async () => {
		const { manager, ids } = longSession();
		const { fresh } = withFillerBefore(manager);
		const controller = new AbortController();
		// Aborted while the first chunk is read; the message is three on.
		setImmediate(() => controller.abort());
		const finds = diskFinds();

		const read = await messagesOnDiskAsync(
			fresh.getBranch(),
			new Set([ids.early]),
			{ signal: controller.signal, finds },
		);

		expect(read).toEqual([]);
		expect(
			finds.located.has(ids.early),
			"the early session is not marked found once the scan is aborted",
		).toBe(false);
		expect([...finds.absent]).toEqual([]);
		const after = messagesOnDisk(
			fresh.getBranch(),
			new Set([ids.early]),
			finds,
		);
		expect(texts(after)).toEqual(["early question"]);
		expect(finds.scanned).toBe(2);
	});

	it("are not looked for again once their parent is gone from disk", () => {
		const { manager, ids } = longSession();
		const branch = rolledInto(manager).fresh.getBranch();
		rmSync(manager.getSessionFile() ?? "");
		const finds = diskFinds();
		expect(messagesOnDisk(branch, new Set([ids.early]), finds)).toEqual([]);

		expect(messagesOnDisk(branch, new Set([ids.early]), finds)).toEqual([]);
		expect([...finds.absent]).toEqual([ids.early]);
		expect(finds.scanned).toBe(1);
	});

	// Root reads a file whatever its mode, so the log never turns unreadable.
	it.skipIf(process.getuid?.() === 0)(
		"are looked for again once a parent unreadable for a while can be read",
		() => {
			const { manager, ids } = longSession();
			const branch = rolledInto(manager).fresh.getBranch();
			const file = manager.getSessionFile() ?? "";
			const finds = diskFinds();
			chmodSync(file, 0o000);
			try {
				expect(messagesOnDisk(branch, new Set([ids.early]), finds)).toEqual([]);
			} finally {
				chmodSync(file, 0o600);
			}

			const read = messagesOnDisk(branch, new Set([ids.early]), finds);

			expect(texts(read)).toEqual(["early question"]);
			expect(finds.scanned).toBe(2);
		},
	);

	it("pause once a chunk, all through a long log", async () => {
		const { manager, ids } = longSession();
		const { fresh } = withFillerBefore(manager);
		let turns = 0;
		let reading = true;
		const tick = () => {
			turns++;
			if (reading) setImmediate(tick);
		};
		setImmediate(tick);

		const read = await messagesOnDiskAsync(
			fresh.getBranch(),
			new Set([ids.early]),
		);
		reading = false;

		// Three chunks of filler come before the message: one pause each.
		expect(turns).toBeGreaterThanOrEqual(3);
		expect(read.map((entry) => entry.id)).toEqual([ids.early]);
	});
});

/**
 * The session rolled over, with lines enough to fill a few chunks put
 * before everything its parent log holds after the header, so a reader
 * meets them before any message.
 */
function withFillerBefore(manager: SessionManager) {
	const rolled = rolledInto(manager);
	const file = manager.getSessionFile() ?? "";
	const [header, ...rest] = readFileSync(file, "utf8").split("\n");
	const filler = `${JSON.stringify({ type: "custom", customType: "filler", data: "x".repeat(1000) })}\n`;
	writeFileSync(
		file,
		`${header}\n${filler.repeat((3 * CHUNK_BYTES) / 1024)}${rest.join("\n")}`,
	);
	return rolled;
}

/** The text of each message entry, in order. */
function texts(entries: readonly Entry[]): string[] {
	return entries.map((entry) => {
		const content = (entry.message as { content?: unknown } | undefined)
			?.content;
		if (typeof content === "string") return content;
		return Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";
	});
}

describe("a log's lines, read a chunk at a time", () => {
	it("are every line of the log, whole past a chunk, each read before its buffer is refilled", () => {
		const path = join(dir, "log.jsonl");
		// Past two chunks, of letters two, four and one bytes wide. "first"
		// is a view of the first chunk's buffer, so a line decoded after
		// the next read fills that buffer would come back as other bytes.
		const long = "é🌲a".repeat(300_000);
		const lines = ["first", long, "", `${long}ü`, "last, cut short"];
		writeFileSync(path, lines.join("\n"));

		expect([...logLines(path)]).toEqual(lines);
	});

	it("are whole where a short line straddles two chunks", () => {
		const path = join(dir, "log.jsonl");
		// The reader's chunk is a mebibyte: "short" starts two bytes before
		// its end and finishes in the next, one line either side of it.
		const lines = ["a".repeat(1024 * 1024 - 3), "short", "end"];
		writeFileSync(path, lines.join("\n"));

		expect([...logLines(path)]).toEqual(lines);
	});

	// Linux names each open descriptor's file under /proc/self/fd.
	it.skipIf(process.platform !== "linux")(
		"close the log when their reader stops before the end",
		() => {
			const path = join(dir, "log.jsonl");
			writeFileSync(path, "one\ntwo\nthree\n");
			// A descriptor's link names the file through no symlink.
			const real = realpathSync(path);
			const holding = (): number =>
				readdirSync("/proc/self/fd").filter((fd) => {
					try {
						return readlinkSync(join("/proc/self/fd", fd)) === real;
					} catch {
						// The descriptor readdir itself held is closed by now.
						return false;
					}
				}).length;
			const lines = logLines(path);

			expect(lines.next().value).toBe("one");
			expect(holding()).toBe(1);
			lines.return(undefined);
			expect(holding()).toBe(0);
		},
	);

	it("add what each read brought in to the tally, the whole file in all", () => {
		const path = join(dir, "log.jsonl");
		writeFileSync(path, `one\n${"é🌲".repeat(400_000)}\nthree\n`);
		const tally = { bytes: 0 };

		const count = [...logLines(path, tally)].length;

		expect(count).toBe(3);
		expect(tally.bytes).toBe(readFileSync(path).length);
	});

	it("leave out a line longer than the longest asked for, counting its bytes", () => {
		const path = join(dir, "log.jsonl");
		const chunk = 1024 * 1024;
		const longest = chunk + 10;
		// Too long in one chunk, then across chunks; one just fits, and an
		// unended last line is too long.
		const fits = "c".repeat(longest);
		const lines = [
			"a".repeat(longest + 1),
			"short",
			"b".repeat(3 * chunk),
			fits,
			"after",
			"d".repeat(longest + 1),
		];
		writeFileSync(path, lines.join("\n"));
		const tally = { bytes: 0 };

		expect([...logLines(path, tally, longest)]).toEqual([
			"short",
			fits,
			"after",
		]);
		expect(tally.bytes).toBe(readFileSync(path).length);
		expect([...logLines(path, tally, 4)]).toEqual([]);
		expect([...logLines(path, tally, 5)]).toEqual(["short", "after"]);
	});

	it("hold no more of a line than the longest asked for, however long it runs", () => {
		const path = join(dir, "log.jsonl");
		const chunk = 1024 * 1024;
		const longest = chunk + 10;
		// One line runs eight chunks; one fills a chunk and ends just past
		// the longest, in the next.
		const lines = ["x".repeat(8 * chunk), "y".repeat(longest + 1), "end"];
		writeFileSync(path, `${lines.join("\n")}\n`);
		const copied: number[] = [];
		const joined: number[] = [];
		const from = vi.spyOn(Buffer, "from");
		const concat = vi.spyOn(Buffer, "concat");
		try {
			expect([...logLines(path, { bytes: 0 }, longest)]).toEqual(["end"]);
			for (const result of from.mock.results) {
				if (Buffer.isBuffer(result.value)) copied.push(result.value.length);
			}
			for (const result of concat.mock.results) {
				if (Buffer.isBuffer(result.value)) joined.push(result.value.length);
			}
		} finally {
			from.mockRestore();
			concat.mockRestore();
		}

		// What waited of each long line, before it passed the longest.
		expect(copied.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(
			2 * longest,
		);
		expect(joined).toEqual([]);
	});

	it("are none from a pipe, rather than a wait on it", () => {
		const file = join(dir, "log.jsonl");
		execFileSync("mkfifo", [file]);
		// The pipe already holds a log and stays open for writing, so a
		// reader that took it would find the line, and none can block.
		const pipe = openSync(file, constants.O_RDWR | constants.O_NONBLOCK);
		try {
			expect(writeSync(pipe, "a line in a pipe\n")).toBe(17);
			expect([...logLines(file)]).toEqual([]);
		} finally {
			closeSync(pipe);
		}
	});
});

describe("the fresh log on disk", () => {
	it("is written whole, with no partial file left", () => {
		const { manager } = longSession();
		const { path, rolled } = rolledInto(manager);
		const lines = readFileSync(path, "utf8").trim().split("\n");

		expect(lines).toHaveLength(rolled.entries.length + 1);
		expect(JSON.parse(lines[0] ?? "{}").type).toBe("session");
		expect(
			readdirSync(dir).filter((name) => name.endsWith(".partial")),
		).toEqual([]);
		expect(existsSync(path), `${path} is written`).toBe(true);
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
