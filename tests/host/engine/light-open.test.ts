/**
 * A hosted conversation's log opened light holds what pi's own open and
 * the kept view hold, and what the view leaves out is never held whole,
 * while pi's own open stands wherever the light one can't match it.
 *
 * Long because it tests one module, light-open.ts, and every case builds
 * on the same compacted-log builder, pi's own open to compare against and
 * the stand-ins for pi's session manager, so splitting it would only move
 * those helpers into a fixture each part imports.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	CURRENT_SESSION_VERSION,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStanding } from "../../../host/engine/gone-folder.ts";
import {
	holdKeptHistory,
	leftOutOf,
} from "../../../host/engine/kept-history.ts";
import {
	heldLight,
	LightFellBack,
	LightOpensOff,
	type LightPi,
	openHeld,
	openKept,
	readLight,
} from "../../../host/engine/light-open.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import type { Entry } from "../../../lib/internal/session/rollover.ts";

// The bytes the light open reads of a log, counted, so a case can tell a
// look at a log's header from a read of the whole of it; and a call made
// as it opens a file, so a case can write a log over between two reads.
const reads = vi.hoisted(() => ({
	bytes: 0,
	opening: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		openSync: (...args: Parameters<typeof fs.openSync>) => {
			reads.opening?.();
			return fs.openSync(...args);
		},
		readSync: (...args: Parameters<typeof fs.readSync>) => {
			const read = fs.readSync(...args);
			reads.bytes += read;
			return read;
		},
	};
});

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "light-open-"));
});

afterEach(() => {
	reads.opening = undefined;
	rmSync(dir, { recursive: true, force: true });
});

/** The usage pi records for a turn costing `cost`. */
function usage(cost: number) {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

/** An answer as pi records one, holding `content`. */
function answer(content: unknown[], cost: number) {
	return {
		role: "assistant" as const,
		content,
		api: "openai-completions" as const,
		provider: "faux",
		model: "faux-1",
		usage: usage(cost),
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/**
 * A turn that calls a tool: the question, an answer that thinks and
 * calls, the tool's result with its details, and the last answer. Each
 * text holds characters of two to four bytes, so a small read splits them.
 */
function toolTurn(sessions: SessionManager, text: string, cost = 0.5): void {
	sessions.appendMessage({
		role: "user",
		content: `${text} é✓🙂`,
		timestamp: Date.now(),
	});
	const call = `call-${text.replace(/ /g, "-")}`;
	sessions.appendMessage(
		answer(
			[
				{ type: "thinking", thinking: `pondering ${text} ✓`, signature: "s" },
				{ type: "toolCall", id: call, name: "bash", arguments: { c: "ls" } },
			],
			cost,
		) as never,
	);
	sessions.appendMessage({
		role: "toolResult",
		toolCallId: call,
		toolName: "bash",
		content: [{ type: "text", text: `output of ${text} 🙂`.repeat(20) }],
		details: { full: `everything ${text} printed é`.repeat(20) },
		isError: false,
		timestamp: Date.now(),
	} as never);
	sessions.appendMessage(
		answer([{ type: "text", text: `answer to ${text} é` }], cost) as never,
	);
}

/** The id of the user message on the branch whose text starts `text`. */
function userId(sessions: SessionManager, text: string): string {
	const entry = sessions
		.getBranch()
		.find(
			(e) =>
				e.type === "message" &&
				e.message.role === "user" &&
				typeof e.message.content === "string" &&
				e.message.content.startsWith(text),
		);
	if (!entry) throw new Error(`no user message ${text}`);
	return entry.id;
}

/** A compaction's details and usage, as pi's own summariser records them. */
function summarised(sessions: SessionManager, summary: string, from: string) {
	sessions.appendCompaction(
		summary,
		userId(sessions, from),
		900,
		{ summariser: "conversation", readFiles: ["a file ✓"] },
		false,
		usage(0.25) as never,
	);
}

/**
 * A log written by pi with every kind of entry the light read drops
 * values from, two compactions keeping the system message, with their
 * details and usage, an abandoned branch and state, the last compaction
 * keeping from "kept one"; answers with its file.
 */
function compactedLog(cwd: string = dir): string {
	const sessions = SessionManager.create(cwd, dir);
	sessions.appendModelChange("faux", "faux-1");
	sessions.appendThinkingLevelChange("high");
	sessions.appendMessage({
		role: "system",
		content: "the base prompt é".repeat(20),
		toolsAdded: [{ name: "bash", description: "runs ✓", parameters: {} }],
		timestamp: Date.now(),
	} as never);
	toolTurn(sessions, "early one", 1);
	const note = "a long note é".repeat(30);
	sessions.appendCustomMessageEntry("peers", note, false, { by: "a peer ✓" });
	summarised(sessions, "the first summary é", "early one");
	const fork = sessions.getLeafId() ?? "";
	toolTurn(sessions, "abandoned", 3);
	sessions.branchWithSummary(fork, "what the abandoned branch did ✓");
	sessions.appendCustomEntry("away-state", { away: true });
	toolTurn(sessions, "early two", 2);
	toolTurn(sessions, "kept one");
	summarised(sessions, "the last summary 🙂", "kept one");
	toolTurn(sessions, "after");
	const file = sessions.getSessionFile();
	if (!file) throw new Error("pi named no file");
	return file;
}

/** The ids `file` holds, so the view's own ids can be told apart. */
function idsOf(file: string): Set<string> {
	const ids = new Set<string>();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		try {
			const id: unknown = JSON.parse(line).id;
			if (typeof id === "string") ids.add(id);
		} catch {
			// A line that isn't JSON holds no id.
		}
	}
	return ids;
}

/**
 * What a held manager answers, its view's own random ids named by the
 * order they first appear, so two holds of one log compare equal.
 */
function answers(manager: SessionManager, file: string): unknown {
	const ids = idsOf(file);
	const named = new Map<string, string>();
	const text = JSON.stringify({
		header: manager.getHeader(),
		entries: manager.getEntries(),
		leaf: manager.getLeafId(),
		context: manager.buildSessionContext(),
		left: leftOutOf(manager),
		id: manager.getSessionId(),
		cwd: manager.getCwd(),
		file: manager.getSessionFile(),
		dir: manager.getSessionDir(),
	});
	return JSON.parse(
		text.replace(/"([0-9a-f]{8})"/g, (whole, id: string) => {
			if (ids.has(id)) return whole;
			if (!named.has(id)) named.set(id, `view-${named.size}`);
			return `"${named.get(id)}"`;
		}),
	);
}

/**
 * pi's own open of `file`, held as the engine holds it, holding a kept
 * view unless `whole`.
 */
function piHeld(file: string, whole = false): SessionManager {
	const held = holdKeptHistory(SessionManager.open(file));
	if (whole) expect(leftOutOf(held)).toBeUndefined();
	else expect(leftOutOf(held)).toBeDefined();
	return held;
}

/** Where `file`'s only line holding `text` sits among its lines. */
function lineOf(file: string, text: string): number {
	const found = readFileSync(file, "utf8")
		.split("\n")
		.flatMap((line, at) => (line.includes(text) ? [at] : []));
	if (found.length !== 1) throw new Error(`${found.length} lines hold ${text}`);
	return found[0] ?? -1;
}

/** pi's session layer as the engine hands it to the light open. */
const PI: LightPi = { SessionManager, version: CURRENT_SESSION_VERSION };

/**
 * A stand-in for pi's SessionManager class: what the light open builds
 * with `new` is what `make` gives back from the arguments it was given.
 */
function constructedBy(make: (args: unknown[]) => unknown): unknown {
	return new Proxy(class {}, {
		construct(_target, args): object {
			const made = make(args);
			if (typeof made !== "object" || made === null)
				throw new Error("a stand-in built something that isn't a manager");
			return made;
		},
	});
}

/** The light open of `file` as the engine makes it, failing when it fell back. */
function lightHeld(file: string): SessionManager {
	const opened = openKept(PI, file);
	if (!opened) throw new Error("the light open fell back to pi's");
	const { manager } = opened;
	if (!(manager instanceof SessionManager))
		throw new Error("the light open built another kind of manager");
	return manager;
}

/** The parsed lines of `file`. */
function lines(file: string): unknown[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

describe("a log opened light", () => {
	it("lets go of its light read once it holds the kept view", async () => {
		setFlagsFromString("--expose-gc");
		const gc: unknown = runInNewContext("gc");
		if (typeof gc !== "function") throw new Error("this node won't collect");
		let given: WeakRef<object> | undefined;
		const watched = constructedBy((args) => {
			const entries = args[5];
			if (typeof entries === "object" && entries !== null)
				given = new WeakRef(entries);
			return Reflect.construct(SessionManager, args);
		});
		const pi = { SessionManager: watched, version: CURRENT_SESSION_VERSION };
		const opened = openKept(pi, compactedLog());
		if (!opened) throw new Error("the light open fell back to pi's");
		expect(leftOutOf(opened.manager)).toBeDefined();

		// A weak reference holds its value until the job that made it ends.
		await new Promise((done) => setImmediate(done));
		gc();

		expect(given, "the open gave pi no entries").toBeDefined();
		expect(
			given?.deref(),
			"the held conversation keeps the light read alive",
		).toBeUndefined();
		expect(opened.manager.getEntries().length).toBeGreaterThan(0);
	});

	it("holds what pi's open holds once it holds the kept view", () => {
		const file = compactedLog();
		const before = readFileSync(file, "utf8");
		expect(answers(lightHeld(file), file)).toEqual(answers(piHeld(file), file));
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("with no compaction is read once and held whole, as pi's open holds it", () => {
		const sessions = SessionManager.create(dir, dir);
		toolTurn(sessions, "only");
		toolTurn(sessions, "second");
		const file = sessions.getSessionFile() ?? "";
		const read = readLight(file);
		expect(read?.lightened).toBe(0);
		expect(read?.entries).toEqual(lines(file));
		const light = lightHeld(file);
		expect(leftOutOf(light)).toBeUndefined();
		expect(answers(light, file)).toEqual(answers(piHeld(file, true), file));
	});

	it("whose last entry is its compaction holds what pi's open holds", () => {
		const sessions = SessionManager.create(dir, dir);
		toolTurn(sessions, "early one");
		toolTurn(sessions, "kept one");
		summarised(sessions, "the only summary", "kept one");
		const file = sessions.getSessionFile() ?? "";
		expect(readLight(file)?.lightened).toBeGreaterThan(0);
		expect(answers(lightHeld(file), file)).toEqual(answers(piHeld(file), file));
	});

	it("holds what pi's open holds on a branch back past a later compaction on another", () => {
		const sessions = SessionManager.create(dir, dir);
		toolTurn(sessions, "early");
		toolTurn(sessions, "kept");
		summarised(sessions, "the first summary", "kept");
		toolTurn(sessions, "after the first");
		const fork = sessions.getLeafId() ?? "";
		toolTurn(sessions, "elsewhere one");
		toolTurn(sessions, "elsewhere two");
		summarised(sessions, "the other summary", "elsewhere two");
		toolTurn(sessions, "elsewhere after");
		sessions.branch(fork);
		toolTurn(sessions, "back on the first");
		const file = sessions.getSessionFile() ?? "";
		// The other branch's compaction comes later in the log, so the light
		// read lets go of the first compaction's kept entries and of it.
		expect(readLight(file)?.lightened).toBeGreaterThan(0);
		const light = lightHeld(file);
		expect(answers(light, file)).toEqual(answers(piHeld(file), file));
		const compactions = light
			.getBranch()
			.flatMap((e) => (e.type === "compaction" ? [e.summary] : []));
		expect(compactions).toEqual(["the first summary"]);
	});

	it("skips blank and malformed lines as pi's open does", () => {
		const file = compactedLog();
		const text = readFileSync(file, "utf8").split("\n");
		text.splice(5, 0, "", "{not json", "   ", "null");
		writeFileSync(file, text.join("\n"));
		expect(answers(lightHeld(file), file)).toEqual(answers(piHeld(file), file));
	});

	it("takes its header past lines pi's open skips before it, as pi's open does", () => {
		const file = compactedLog();
		const text = readFileSync(file, "utf8").split("\n");
		text.unshift("", "{not json", "   ", "null");
		writeFileSync(file, text.join("\n"));
		expect(answers(lightHeld(file), file)).toEqual(answers(piHeld(file), file));
	});

	it("takes its header past more lines than a header look reads, looking no further", () => {
		const file = compactedLog();
		// A line pi's open skips, three of a header look's limits long.
		const skipped = "x".repeat(3 * 1024 * 1024);
		writeFileSync(file, `${skipped}\n${readFileSync(file, "utf8")}`);
		// What the look read, taken as the log is opened to be read whole.
		let opens = 0;
		let looked = 0;
		reads.bytes = 0;
		reads.opening = () => {
			opens += 1;
			if (opens === 2) looked = reads.bytes;
		};
		const light = lightHeld(file);
		// A third open, if any, is the kept view reading lines back whole.
		expect(
			opens,
			"it looked at the header, then read the log",
		).toBeGreaterThanOrEqual(2);
		expect(looked, "the header look read past its limit").toBeLessThanOrEqual(
			1024 * 1024,
		);
		expect(answers(light, file)).toEqual(answers(piHeld(file), file));
	});

	it("adds only its next entry to the log, off the leaf it opened on", () => {
		const file = compactedLog();
		const before = readFileSync(file, "utf8");
		const light = lightHeld(file);
		const leaf = light.getLeafId();
		light.appendCustomEntry("note", { n: 1 });
		const after = readFileSync(file, "utf8");
		expect(
			after.startsWith(before),
			"the light manager only appends to the log",
		).toBe(true);
		const added = after.slice(before.length).trim().split("\n");
		expect(added.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({ customType: "note", parentId: leaf }),
		]);
	});

	it("says what its kept view says once it has opened", () => {
		const file = compactedLog();
		const said: unknown[] = [];
		const opened = openKept(PI, file, (what) => said.push(what));
		if (!opened || !(opened.manager instanceof SessionManager))
			throw new Error("the light open fell back to pi's");
		expect(said).toEqual([]);
		opened.manager.getTree();
		expect(said).toEqual([
			expect.stringContaining("whole log back into memory to show its tree"),
		]);
	});

	it("opens in the folder that stands when its own is gone, as pi's does", () => {
		const gone = join(dir, "tree", "gone");
		mkdirSync(gone, { recursive: true });
		const file = compactedLog(gone);
		rmSync(join(dir, "tree"), { recursive: true });
		const before = readFileSync(file, "utf8");
		const light = openKept(PI, file, () => {}, dir);
		const standing = openStanding(SessionManager, file, dir);
		const held = holdKeptHistory(standing.manager);
		if (!light || !(light.manager instanceof SessionManager))
			throw new Error("the light open fell back to pi's");
		if (!(held instanceof SessionManager))
			throw new Error("pi's open gave another manager");
		expect(light.left).toBe(standing.left);
		expect(light.left).toBe(gone);
		expect(light.manager.getCwd()).toBe(dir);
		expect(answers(light.manager, file)).toEqual(answers(held, file));
		expect(readFileSync(file, "utf8")).toBe(before);
	});
});

describe("a light read", () => {
	it("drops the values only a held entry needs before the last compaction, keeping what the view reads", () => {
		const file = compactedLog();
		const read = readLight(file);
		if (!read) throw new Error("no light read");
		const last = read.entries
			.map((entry) => isRecord(entry) && entry.type === "compaction")
			.lastIndexOf(true);
		expect(read.entries.slice(last)).toEqual(lines(file).slice(last));
		const records = read.entries.slice(0, last).filter(isRecord);
		const whole = lines(file).map((entry) => JSON.stringify(entry));
		const changed = read.entries
			.slice(0, last)
			.filter((entry, i) => JSON.stringify(entry) !== whole[i]);
		expect(changed.length).toBeGreaterThan(0);
		expect(read.lightened).toBe(changed.length);
		const said = (role: string) =>
			records.flatMap(({ message }) =>
				isRecord(message) && message.role === role ? [message] : [],
			);
		const typed = (type: string) =>
			records.filter((entry) => entry.type === type);
		expect(said("assistant").length).toBeGreaterThan(0);
		for (const message of said("assistant")) {
			expect(message).toMatchObject({ provider: "faux", model: "faux-1" });
			expect(message.usage).toMatchObject({ input: 10, output: 10 });
			expect(message.content).toBeInstanceOf(Array);
			for (const part of [message.content].flat())
				expect(isRecord(part) && Object.keys(part)).toEqual(["type"]);
		}
		expect(said("assistant").map(({ content }) => content)).toContainEqual([
			{ type: "thinking" },
			{ type: "toolCall" },
		]);
		expect(said("toolResult").length).toBeGreaterThan(0);
		for (const message of said("toolResult")) {
			expect(message.content).toEqual([]);
			expect(message).not.toHaveProperty("details");
		}
		const users = said("user").map(({ content }) => content);
		expect(users).toContain("early one é✓🙂");
		const summaries = [...typed("compaction"), ...typed("branch_summary")];
		expect(summaries.map(({ summary }) => summary)).toEqual(["", ""]);
		const written = lines(file).filter(
			(entry) => isRecord(entry) && entry.type === "compaction",
		);
		expect(written).toEqual([
			expect.objectContaining({ systemMessage: expect.anything() }),
			expect.objectContaining({ systemMessage: expect.anything() }),
		]);
		expect(typed("compaction")).toEqual([
			expect.not.objectContaining({ systemMessage: expect.anything() }),
		]);
		expect(typed("compaction")).toEqual([
			expect.objectContaining({
				details: { summariser: "conversation", readFiles: ["a file ✓"] },
				usage: expect.objectContaining({ output: 10 }),
			}),
		]);
		expect(typed("custom_message")).toEqual([
			expect.not.objectContaining({ details: expect.anything() }),
		]);
		expect(typed("custom_message").map(({ content }) => content)).toEqual([""]);
		expect(typed("custom")).toContainEqual(
			expect.objectContaining({ data: { away: true } }),
		);
	});

	it("reads every entry back whole from its line, at any read size", () => {
		const file = compactedLog();
		for (const size of [1, 7, 4096]) {
			const read = readLight(file, size);
			if (!read) throw new Error("no light read");
			expect(read.whole(read.entries as Entry[])).toEqual(lines(file));
		}
	});

	it("refuses to read back a light line that no longer parses", () => {
		const file = compactedLog();
		const read = readLight(file);
		if (!read) throw new Error("no light read");
		const text = readFileSync(file, "utf8").split("\n");
		const at = lineOf(file, "output of early one");
		const line = text[at] ?? "";
		expect(line.startsWith("{"), "the line read light is a JSON object").toBe(
			true,
		);
		text[at] = `[${line.slice(1)}`;
		writeFileSync(file, text.join("\n"));
		expect(() => read.whole(read.entries as Entry[])).toThrow(
			/no longer holds/,
		);
	});

	it("refuses to read back a line that now holds another entry", () => {
		const file = compactedLog();
		const read = readLight(file);
		if (!read) throw new Error("no light read");
		const text = readFileSync(file, "utf8");
		const at = text.indexOf('"role":"toolResult"');
		const line = text.lastIndexOf("\n", at) + 1;
		const id = text.indexOf('"id":"', line) + '"id":"'.length;
		writeFileSync(file, `${text.slice(0, id)}ffffffff${text.slice(id + 8)}`);
		expect(() => read.whole(read.entries as Entry[])).toThrow(
			/no longer holds/,
		);
	});
});

describe("pi's own open stands", () => {
	/**
	 * Whether the light open of `file` fell back, `file` left as it was,
	 * saying `says` as it did: nothing, for a log pi's own open reads as
	 * it reads any.
	 */
	function fallsBack(
		file: string,
		pi: LightPi = PI,
		says: unknown[] = [],
	): boolean {
		const before = readFileSync(file, "utf8");
		const said: unknown[] = [];
		const opened = openKept(pi, file, (what) => said.push(what));
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(said).toEqual(says);
		return opened === undefined;
	}

	/** What a changed session manager says: that light opens are off. */
	const OFF = [expect.any(LightOpensOff)];

	it("for a log whose view would hold entries read light whole", () => {
		const sessions = SessionManager.create(dir, dir);
		toolTurn(sessions, "first");
		toolTurn(sessions, "second");
		const first = sessions.getEntries()[0]?.id ?? "";
		sessions.appendCompaction("from the start", first, 900);
		const file = sessions.getSessionFile() ?? "";
		expect(readLight(file)?.lightened).toBeGreaterThan(0);
		expect(fallsBack(file), "it falls back to pi's own open").toBe(true);
	});

	it("for a log whose leaf's branch passes no compaction, saying nothing", () => {
		const sessions = SessionManager.create(dir, dir);
		toolTurn(sessions, "first");
		const fork = sessions.getLeafId() ?? "";
		toolTurn(sessions, "second");
		summarised(sessions, "the summary", "second");
		toolTurn(sessions, "after");
		sessions.branch(fork);
		toolTurn(sessions, "off the branch");
		const file = sessions.getSessionFile() ?? "";
		expect(readLight(file)?.lightened).toBeGreaterThan(0);
		expect(fallsBack(file), "it falls back to pi's own open").toBe(true);
		const held = piHeld(file, true);
		expect(
			held.getBranch().some((e) => e.type === "compaction"),
			"the leaf's branch passes no compaction",
		).toBe(false);
	});

	it("for a log pi would migrate, which pi writes back whole", () => {
		const file = compactedLog();
		const text = readFileSync(file, "utf8");
		writeFileSync(
			file,
			text.replace(`"version":${CURRENT_SESSION_VERSION}`, '"version":2'),
		);
		expect(fallsBack(file), "it falls back to pi's own open").toBe(true);
	});

	/** A mebibyte, the most a look for a header reads, and a light read's read. */
	const MIB = 1024 * 1024;

	/**
	 * Headers pi's own to open whatever follows them: a log pi would
	 * migrate, one whose header names no folder, one whose first entry
	 * isn't a session's, and one whose header names no id.
	 */
	const LEFT_TO_PI = [
		(header: Record<string, unknown>) => ({ ...header, version: 2 }),
		({ cwd: _, ...header }: Record<string, unknown>) => header,
		(header: Record<string, unknown>) => ({ ...header, type: "message" }),
		({ id: _, ...header }: Record<string, unknown>) => header,
	];

	/**
	 * A compacted log whose header `changed` makes, after `skipped` (lines
	 * pi's open skips) and before an entry three of the open's reads long,
	 * so reading the whole log is told from a read up to its header; and
	 * the header's line.
	 */
	function logLeftToPi(
		changed: (header: Record<string, unknown>) => Record<string, unknown>,
		skipped: string[] = [],
	): { file: string; first: string } {
		const file = compactedLog();
		const [header = "", ...rest] = readFileSync(file, "utf8").split("\n");
		const long = JSON.stringify({
			type: "custom",
			customType: "long",
			data: "x".repeat(3 * MIB),
		});
		const first = JSON.stringify(changed(JSON.parse(header)));
		writeFileSync(file, [...skipped, first, long, ...rest].join("\n"));
		return { file, first };
	}

	it("for a log its header leaves to pi, reading no more of it than the header", () => {
		for (const changed of LEFT_TO_PI) {
			const { file, first } = logLeftToPi(changed);
			reads.bytes = 0;
			expect(fallsBack(file), "the log is left to pi's own open").toBe(true);
			// The header and what one look's read takes past it.
			expect(
				reads.bytes,
				"the log was read past its header",
			).toBeLessThanOrEqual(Buffer.byteLength(first) + 1 + 4096);
		}
	});

	it("for a log its header leaves to pi just inside a look's limit, found by the look alone", () => {
		for (const changed of LEFT_TO_PI) {
			// Lines pi's open skips, ending a few kilobytes short of the limit.
			const { file } = logLeftToPi(changed, ["x".repeat(MIB - 8 * 1024)]);
			reads.bytes = 0;
			expect(fallsBack(file), "the log is left to pi's own open").toBe(true);
			expect(
				reads.bytes,
				"the look gave up short of the header, or the log was read on",
			).toBeLessThanOrEqual(MIB);
		}
	});

	it("for a log its header leaves to pi past a look's limit, reading no further than the header", () => {
		for (const changed of LEFT_TO_PI) {
			const skipped = "x".repeat(3 * MIB);
			const { file } = logLeftToPi(changed, [skipped]);
			reads.bytes = 0;
			expect(fallsBack(file), "the log is left to pi's own open").toBe(true);
			// The look's limit, then the light read up to the read holding the
			// header, which ends a few hundred bytes into the read after the
			// skipped line.
			expect(
				reads.bytes,
				"the log was read past its header",
			).toBeLessThanOrEqual(MIB + skipped.length + MIB);
		}
	});

	it("for a log written over between its header and the rest, as its new header asks", () => {
		const file = compactedLog();
		const migrated = readFileSync(file, "utf8").replace(
			`"version":${CURRENT_SESSION_VERSION}`,
			'"version":2',
		);
		// The header looked at first, and the log written over before the
		// open reads the whole of it.
		let opens = 0;
		reads.opening = () => {
			opens += 1;
			if (opens === 2) writeFileSync(file, migrated);
		};
		const said: unknown[] = [];
		const opened = openKept(PI, file, (what) => said.push(what));
		expect(opens, "it looked at the header, then read the log").toBe(2);
		expect(opened, "the log is left to pi's own open").toBeUndefined();
		expect(said, "it isn't a failure, so nothing is said").toEqual([]);
		expect(readFileSync(file, "utf8")).toBe(migrated);
	});

	it("for a pi that doesn't say its log version, saying light opens are off", () => {
		const pi = { SessionManager, version: undefined };
		const said: unknown[] = [];
		expect(openKept(pi, compactedLog(), (what) => said.push(what))).toBe(
			undefined,
		);
		expect(said).toEqual([expect.any(LightOpensOff)]);
		expect(String(said[0])).toContain("log version");
	});

	it("for a pi that no longer has a session manager, saying so once", () => {
		const pi = { SessionManager: undefined, version: CURRENT_SESSION_VERSION };
		const said: unknown[] = [];
		const file = compactedLog();
		expect(openKept(pi, file, (what) => said.push(what))).toBe(undefined);
		expect(openKept(pi, file, (what) => said.push(what))).toBe(undefined);
		expect(said).toEqual([expect.any(LightOpensOff)]);
		expect(String(said[0])).toContain("session manager");
	});

	it("for a log whose last line is unfinished, which pi ends itself", () => {
		const file = compactedLog();
		writeFileSync(file, `${readFileSync(file, "utf8")}{"type":"cus`);
		expect(fallsBack(file), "it falls back to pi's own open").toBe(true);
	});

	it("for a file that isn't a log", () => {
		const file = join(dir, "not-a-log.jsonl");
		writeFileSync(file, '{"type":"message","id":"x"}\n');
		expect(fallsBack(file), "it falls back to pi's own open").toBe(true);
	});

	it("for a file whose first line isn't a session's, though it names the version", () => {
		const file = join(dir, "not-a-log.jsonl");
		const line = { type: "message", id: "x", version: CURRENT_SESSION_VERSION };
		writeFileSync(file, `${JSON.stringify(line)}\n`);
		expect(readLight(file)).toBeUndefined();
	});

	it("for a session header with no id", () => {
		const file = compactedLog();
		const [header = "", ...rest] = readFileSync(file, "utf8").split("\n");
		const { id: _, ...unnamed } = JSON.parse(header);
		writeFileSync(file, [JSON.stringify(unnamed), ...rest].join("\n"));
		expect(readLight(file)).toBeUndefined();
	});

	it("for a session header naming no folder, which pi's open fills in itself", () => {
		const file = compactedLog();
		const [header = "", ...rest] = readFileSync(file, "utf8").split("\n");
		const { cwd: _, ...nowhere } = JSON.parse(header);
		writeFileSync(file, [JSON.stringify(nowhere), ...rest].join("\n"));
		expect(readLight(file)?.lightened).toBeGreaterThan(0);
		const said: unknown[] = [];
		expect(openKept(PI, file, (what) => said.push(what))).toBeUndefined();
		expect(said, "it isn't a failure, so nothing is said").toEqual([]);
	});

	it("for a pi whose session manager no longer takes entries as this expects", () => {
		class Other {}
		const pi = { SessionManager: Other, version: CURRENT_SESSION_VERSION };
		expect(
			fallsBack(compactedLog(), pi, OFF),
			"it falls back to pi's own open",
		).toBe(true);
	});

	/** A pi whose session manager `change`s what it built before answering. */
	function changing(change: (manager: Record<string, unknown>) => void) {
		const changes = constructedBy((args) => {
			const made: unknown = Reflect.construct(SessionManager, args);
			if (isRecord(made)) change(made);
			return made;
		});
		return { SessionManager: changes, version: CURRENT_SESSION_VERSION };
	}

	it("for a session manager that replaces the entries it was given", () => {
		const pi = changing(({ fileEntries }) => {
			if (Array.isArray(fileEntries)) fileEntries[1] = { ...fileEntries[1] };
		});
		expect(
			fallsBack(compactedLog(), pi, OFF),
			"it falls back to pi's own open",
		).toBe(true);
	});

	it("for a session manager that indexes copies of its entries", () => {
		const pi = changing(({ byId }) => {
			if (byId instanceof Map)
				for (const [id, entry] of byId) byId.set(id, { ...entry });
		});
		expect(
			fallsBack(compactedLog(), pi, OFF),
			"it falls back to pi's own open",
		).toBe(true);
	});

	it("for a session manager that drops an entry it was given", () => {
		const pi = changing(({ fileEntries }) => {
			if (Array.isArray(fileEntries)) fileEntries.pop();
		});
		expect(
			fallsBack(compactedLog(), pi, OFF),
			"it falls back to pi's own open",
		).toBe(true);
	});

	it("for a session manager that writes to another file", () => {
		const pi = changing((manager) => {
			manager.sessionFile = join(dir, "elsewhere.jsonl");
		});
		expect(
			fallsBack(compactedLog(), pi, OFF),
			"it falls back to pi's own open",
		).toBe(true);
	});

	it("for a session manager that would write its log again whole", () => {
		const pi = changing((manager) => {
			manager.flushed = false;
		});
		const said: unknown[] = [];
		expect(openKept(pi, compactedLog(), (what) => said.push(what))).toBe(
			undefined,
		);
		expect(said).toEqual([expect.any(LightOpensOff)]);
	});

	it("for a session manager that fails to open, saying why it fell back", () => {
		const fails = constructedBy(() => {
			throw new Error("no room to open");
		});
		const pi = { SessionManager: fails, version: CURRENT_SESSION_VERSION };
		const said: unknown[] = [];
		expect(openKept(pi, compactedLog(), (what) => said.push(what))).toBe(
			undefined,
		);
		expect(said).toEqual([expect.any(LightFellBack)]);
		expect(String(said[0])).toContain("no room to open");
	});

	it("for a log gone as pi opens it, saying so, with light opens left on", () => {
		let removing = true;
		const removes = constructedBy((args) => {
			if (removing) rmSync(String(args[2]));
			return Reflect.construct(SessionManager, args);
		});
		const pi = { SessionManager: removes, version: CURRENT_SESSION_VERSION };
		const said: unknown[] = [];
		expect(openKept(pi, compactedLog(), (what) => said.push(what))).toBe(
			undefined,
		);
		expect(said).toEqual([expect.any(LightFellBack)]);
		expect(String(said[0])).toContain("was gone as pi opened it");
		removing = false;
		expect(openKept(pi, compactedLog())).toBeDefined();
	});

	it("for a session manager that names another session", () => {
		const pi = changing((manager) => {
			manager.sessionId = "another";
		});
		expect(
			fallsBack(compactedLog(), pi, OFF),
			"it falls back to pi's own open",
		).toBe(true);
	});

	it("for a session manager that reads the log itself rather than take its entries", () => {
		const reads = constructedBy((args) => SessionManager.open(String(args[2])));
		const pi = { SessionManager: reads, version: CURRENT_SESSION_VERSION };
		expect(
			fallsBack(compactedLog(), pi, OFF),
			"it falls back to pi's own open",
		).toBe(true);
	});
});

describe("heldLight", () => {
	it("tells a manager the light open stood with entries read lighter", () => {
		expect(
			heldLight(lightHeld(compactedLog())),
			"a light open with entries read lighter counts as light",
		).toBe(true);
	});

	it("tells pi's own open of the same log apart", () => {
		expect(
			heldLight(piHeld(compactedLog())),
			"pi's own open counts as no light open",
		).toBe(false);
	});

	it("tells a light open of a log with nothing read lighter apart", () => {
		const sessions = SessionManager.create(dir, dir);
		toolTurn(sessions, "only");
		const file = sessions.getSessionFile() ?? "";
		const opened = openKept(PI, file);
		expect(opened).toBeDefined();
		expect(
			heldLight(opened?.manager),
			"a light open with nothing read lighter counts as no light open",
		).toBe(false);
	});

	it("answers false for what is no manager", () => {
		expect(heldLight(undefined), "nothing is no light open").toBe(false);
		expect(heldLight("a manager"), "a string is no light open").toBe(false);
	});
});

describe("a light open that falls back", () => {
	/** A log whose view would hold entries read light, so the light open falls back. */
	function fromTheStart(): string {
		const sessions = SessionManager.create(dir, dir);
		toolTurn(sessions, "first");
		const first = sessions.getEntries()[0]?.id ?? "";
		sessions.appendCompaction("from the start", first, 900);
		return sessions.getSessionFile() ?? "";
	}

	/** pi's own open as the engine makes it, saying `says` as it opens. */
	const whole =
		(says: unknown[]) => (file: string, report: (said: unknown) => void) => {
			for (const said of says) report(said);
			return { manager: holdKeptHistory(SessionManager.open(file)) };
		};

	it("says nothing of a log pi's own open holds whole, as it would any", () => {
		const said: unknown[] = [];
		const file = fromTheStart();
		const opened = openHeld(PI, file, (what) => said.push(what), whole([]));
		expect(said).toEqual([]);
		expect(leftOutOf(opened.manager)).toBeUndefined();
		expect(
			heldLight(opened.manager),
			"a fallen-back open counts as no light open",
		).toBe(false);
	});

	it("says what the hold says once the open stands, as itself", () => {
		const said: unknown[] = [];
		const file = compactedLog();
		const opened = openKept(PI, file, (what) => said.push(what));
		const manager = opened?.manager;
		if (!(manager instanceof SessionManager)) throw new Error("no light open");
		expect(said).toEqual([]);
		// With its log gone and its index failing, the hold's read back whole
		// fails, and says why its index couldn't be built again.
		rmSync(file);
		const failed = new Error("no index");
		Object.assign(manager, {
			_buildIndex: () => {
				throw failed;
			},
		});
		expect(() => manager.getTree()).toThrow();
		expect(said).toEqual([failed]);
	});

	/**
	 * A pi whose session manager, once built, puts a blank line after
	 * `file`'s header, moving every line the light read placed, which pi's
	 * own open skips: its kept view can't be built, and the open falls back.
	 */
	function moving(file: string): LightPi {
		const moves = constructedBy((args) => {
			const made: unknown = Reflect.construct(SessionManager, args);
			const [header, ...rest] = readFileSync(file, "utf8").split("\n");
			writeFileSync(file, [header, "", ...rest].join("\n"));
			return made;
		});
		return { SessionManager: moves, version: CURRENT_SESSION_VERSION };
	}

	it("says once that the kept view couldn't be built, when pi's own open says nothing", () => {
		const said: unknown[] = [];
		const file = compactedLog();
		openHeld(moving(file), file, (what) => said.push(what), whole([]));
		expect(said).toEqual([expect.any(LightFellBack)]);
		const why = said[0] instanceof Error ? said[0].cause : undefined;
		expect(String(why)).toContain("its kept view couldn't be built");
		expect(String(why)).toContain("changed as it opened");
	});

	it("says why its view couldn't be taken where the log stands as pi's own open holds it", () => {
		const sessions = SessionManager.create(dir, dir);
		toolTurn(sessions, "only");
		const file = sessions.getSessionFile() ?? "";
		const unbranched = constructedBy((args) => {
			const made: unknown = Reflect.construct(SessionManager, args);
			if (isRecord(made))
				made.getBranch = () => {
					throw new Error("no branch");
				};
			return made;
		});
		const pi = { SessionManager: unbranched, version: CURRENT_SESSION_VERSION };
		const said: unknown[] = [];
		expect(openKept(pi, file, (what) => said.push(what))).toBeDefined();
		expect(said).toHaveLength(1);
		expect(said[0]).not.toBeInstanceOf(LightFellBack);
		expect(String(said[0])).toContain("no branch");
	});

	it("says light opens are off even when pi's own open says something", () => {
		const said: unknown[] = [];
		class Other {}
		const pi = { SessionManager: Other, version: CURRENT_SESSION_VERSION };
		const failed = new Error("the view failed");
		openHeld(pi, compactedLog(), (what) => said.push(what), whole([failed]));
		expect(said).toEqual([expect.any(LightOpensOff), failed]);
	});

	it("leaves pi's own open to say it when it says something", () => {
		const said: unknown[] = [];
		const failed = new Error("the view failed");
		const file = compactedLog();
		openHeld(moving(file), file, (what) => said.push(what), whole([failed]));
		expect(said).toEqual([failed]);
	});

	it("says once that pi's session layer is not what it reads, and reads no log after", () => {
		const said: unknown[] = [];
		let built = 0;
		class Other {
			constructor() {
				built += 1;
			}
		}
		const pi = { SessionManager: Other, version: CURRENT_SESSION_VERSION };
		const file = compactedLog();
		openKept(pi, file, (what) => said.push(what));
		openKept(pi, file, (what) => said.push(what));
		expect(said).toEqual([expect.any(LightOpensOff)]);
		expect(String(said[0])).toContain("Light opens are off");
		expect(built).toBe(1);
	});
});
