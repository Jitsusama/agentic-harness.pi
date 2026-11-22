import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type JournalMark,
	journalIn,
	journalNow,
	journalSince,
	noteQuestWrite,
} from "../../../../lib/internal/quest/write-journal.ts";

let folder: string;
let file: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "write-journal-"));
	file = journalIn(folder);
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

/**
 * The folders `journalSince` reads from `mark`, its fresh start, or
 * "no journal" when `journalNow` gave no mark.
 */
function dirsSince(mark: JournalMark | undefined): readonly string[] | string {
	if (mark === undefined) return "no journal";
	const read = journalSince(file, mark);
	return read === "started afresh" ? read : read.dirs;
}

/** Where the journal stands now, which a plain journal always gives. */
function markNow(): JournalMark {
	const mark = journalNow(file);
	if (mark === undefined) throw new Error("no mark from a plain journal");
	return mark;
}

describe("the journal of quest writes", () => {
	it("reads the folders noted since a mark, and none before it", () => {
		noteQuestWrite(file, "/q/QEST-A");
		const mark = journalNow(file);
		noteQuestWrite(file, "/q/QEST-B");
		noteQuestWrite(file, "/q/QEST-C");
		expect(dirsSince(mark)).toEqual(["/q/QEST-B", "/q/QEST-C"]);
	});

	it("reads on from the mark a read gives back", () => {
		const first = markNow();
		noteQuestWrite(file, "/q/QEST-A");
		const read = journalSince(file, first);
		if (read === "started afresh") throw new Error("not afresh");
		noteQuestWrite(file, "/q/QEST-B");
		expect(dirsSince(read.mark)).toEqual(["/q/QEST-B"]);
	});

	it("reads every line of a journal made after a mark taken before it", () => {
		const before = journalNow(file);
		expect(before).toEqual({ ino: 0, at: 0 });
		noteQuestWrite(file, "/q/QEST-A");
		expect(dirsSince(before)).toEqual(["/q/QEST-A"]);
	});

	it("reads nothing from a journal no write has made", () => {
		expect(dirsSince(journalNow(file))).toEqual([]);
	});

	it("leaves a line still being written for the next read", () => {
		const mark = markNow();
		noteQuestWrite(file, "/q/QEST-A");
		appendFileSync(file, "/q/QEST-");
		const read = journalSince(file, mark);
		if (read === "started afresh") throw new Error("not afresh");
		expect(read.dirs).toEqual(["/q/QEST-A"]);
		appendFileSync(file, "B\n");
		expect(dirsSince(read.mark)).toEqual(["/q/QEST-B"]);
	});

	it("says it started afresh when the file is another one", () => {
		noteQuestWrite(file, "/q/QEST-A");
		const mark = journalNow(file);
		renameSync(file, `${file}.gone`);
		writeFileSync(file, "/q/QEST-B\n/q/QEST-C\n/q/QEST-D\n");
		expect(dirsSince(mark)).toBe("started afresh");
	});

	it("says it started afresh when the file was replaced, not moved aside", () => {
		noteQuestWrite(file, "/q/QEST-A");
		const mark = journalNow(file);
		unlinkSync(file);
		noteQuestWrite(file, "/q/QEST-B");
		expect(dirsSince(mark)).toBe("started afresh");
	});

	it("reads the last line of a multi-byte name whole", () => {
		const mark = markNow();
		noteQuestWrite(file, "/q/QEST-\u00e9\u00e9");
		appendFileSync(file, Buffer.from([0x2f, 0xc3]));
		const read = journalSince(file, mark);
		if (read === "started afresh") throw new Error("not afresh");
		expect(read.dirs).toEqual(["/q/QEST-\u00e9\u00e9"]);
		appendFileSync(file, Buffer.from([0xa9, 0x0a]));
		expect(dirsSince(read.mark)).toEqual(["/\u00e9"]);
	});

	it("says it started afresh rather than read more than a writer keeps", () => {
		const mark = journalNow(file);
		writeFileSync(file, "/q/QEST-A\n".repeat(220_000));
		expect(dirsSince(mark)).toBe("started afresh");
	});

	it("says it started afresh when the file shrank under the mark", () => {
		noteQuestWrite(file, "/q/QEST-A");
		noteQuestWrite(file, "/q/QEST-B");
		const mark = journalNow(file);
		truncateSync(file, 0);
		expect(dirsSince(mark)).toBe("started afresh");
	});

	it("says it started afresh when the file a mark read is gone", () => {
		noteQuestWrite(file, "/q/QEST-A");
		const mark = journalNow(file);
		rmSync(file);
		expect(dirsSince(mark)).toBe("started afresh");
	});

	it("moves a full journal aside, and reads on through it", () => {
		writeFileSync(file, `${"/q/QEST-A\n".repeat(110_000)}`);
		const mark = journalNow(file);
		appendFileSync(file, "/q/QEST-B\n");
		noteQuestWrite(file, "/q/QEST-C");
		expect(existsSync(`${file}.old`), "the full one moved aside").toBe(true);
		expect(readFileSync(file, "utf8")).toBe("/q/QEST-C\n");
		expect(dirsSince(mark)).toEqual(["/q/QEST-B", "/q/QEST-C"]);
	});

	it("reads on through a journal moved aside before the next is made", () => {
		noteQuestWrite(file, "/q/QEST-A");
		const mark = markNow();
		noteQuestWrite(file, "/q/QEST-B");
		renameSync(file, `${file}.old`);
		const read = journalSince(file, mark);
		if (read === "started afresh") throw new Error("not afresh");
		expect(read.dirs).toEqual(["/q/QEST-B"]);
		noteQuestWrite(file, "/q/QEST-C");
		expect(dirsSince(read.mark)).toEqual(["/q/QEST-C"]);
	});

	it("says it started afresh when a journal moved twice since its mark", () => {
		noteQuestWrite(file, "/q/QEST-A");
		const mark = journalNow(file);
		renameSync(file, `${file}.old`);
		noteQuestWrite(file, "/q/QEST-B");
		renameSync(file, `${file}.old`);
		noteQuestWrite(file, "/q/QEST-C");
		expect(dirsSince(mark)).toBe("started afresh");
	});

	it("never follows a link planted at the journal's name", () => {
		const elsewhere = join(folder, "elsewhere");
		writeFileSync(elsewhere, "");
		symlinkSync(elsewhere, file);
		noteQuestWrite(file, "/q/QEST-A");
		expect(readFileSync(elsewhere, "utf8"), "the link's target").toBe("");
		expect(readFileSync(file, "utf8")).toBe("/q/QEST-A\n");
	});

	it("reads a link planted at the journal's name as a fresh start", () => {
		noteQuestWrite(file, "/q/QEST-A");
		const mark = journalNow(file);
		const elsewhere = join(folder, "elsewhere");
		writeFileSync(elsewhere, "/q/QEST-A\n/q/QEST-B\n");
		renameSync(file, join(folder, "moved"));
		symlinkSync(elsewhere, file);
		expect(dirsSince(mark)).toBe("started afresh");
	});

	it("never waits on a pipe planted at the journal's name", () => {
		execFileSync("mkfifo", [file]);
		expect(journalNow(file), "a pipe is no journal").toBeUndefined();
		noteQuestWrite(file, "/q/QEST-A");
		expect(statSync(file).isFile(), "the pipe moved aside").toBe(true);
		expect(readFileSync(file, "utf8")).toBe("/q/QEST-A\n");
	});

	it("moves aside a folder planted at the journal's name", () => {
		mkdirSync(file);
		expect(journalNow(file), "a folder is no journal").toBeUndefined();
		noteQuestWrite(file, "/q/QEST-A");
		noteQuestWrite(file, "/q/QEST-B");
		expect(readFileSync(file, "utf8")).toBe("/q/QEST-A\n/q/QEST-B\n");
	});

	it("clears a folder at the moved name that blocks moving a folder aside", () => {
		mkdirSync(file);
		mkdirSync(`${file}.old`);
		writeFileSync(join(`${file}.old`, "inside"), "x");
		noteQuestWrite(file, "/q/QEST-A");
		expect(readFileSync(file, "utf8")).toBe("/q/QEST-A\n");
		const mark = markNow();
		noteQuestWrite(file, "/q/QEST-B");
		expect(dirsSince(mark)).toEqual(["/q/QEST-B"]);
	});

	it("clears an empty folder at the moved name and moves a full folder aside", () => {
		mkdirSync(file);
		writeFileSync(join(file, "inside"), "x");
		mkdirSync(`${file}.old`);
		noteQuestWrite(file, "/q/QEST-A");
		expect(readFileSync(file, "utf8")).toBe("/q/QEST-A\n");
		expect(
			existsSync(join(`${file}.old`, "inside")),
			"the full folder moved aside whole",
		).toBe(true);
	});

	it("removes no folder's contents, going without a journal instead", () => {
		mkdirSync(file);
		writeFileSync(join(file, "inside"), "x");
		mkdirSync(`${file}.old`);
		writeFileSync(join(`${file}.old`, "inside"), "y");
		expect(() => noteQuestWrite(file, "/q/QEST-A")).not.toThrow();
		expect(readFileSync(join(file, "inside"), "utf8")).toBe("x");
		expect(readFileSync(join(`${file}.old`, "inside"), "utf8")).toBe("y");
		expect(journalNow(file), "no journal to read").toBeUndefined();
	});

	it("moves a folder aside over a plain journal moved aside before", () => {
		writeFileSync(`${file}.old`, "/q/QEST-OLD\n");
		mkdirSync(file);
		noteQuestWrite(file, "/q/QEST-A");
		expect(readFileSync(file, "utf8")).toBe("/q/QEST-A\n");
	});

	it("gives no mark for a journal this user can't read", () => {
		noteQuestWrite(file, "/q/QEST-A");
		chmodSync(file, 0o200);
		expect(journalNow(file), "an unreadable journal").toBeUndefined();
	});

	it("gives a journal its readers can't open back to its owner at the next write", () => {
		noteQuestWrite(file, "/q/QEST-A");
		chmodSync(file, 0o200);
		noteQuestWrite(file, "/q/QEST-B");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFileSync(file, "utf8")).toBe("/q/QEST-A\n/q/QEST-B\n");
	});

	it("never throws when it can't write, so the quest write stands", () => {
		const nowhere = journalIn(join(folder, "missing", "deeper"));
		expect(() => noteQuestWrite(nowhere, "/q/QEST-A")).not.toThrow();
		expect(existsSync(nowhere)).toBe(false);
	});

	it("keeps the journal to its owner", () => {
		noteQuestWrite(file, "/q/QEST-A");
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});
