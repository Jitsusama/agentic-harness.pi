import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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

/** The folders `journalSince` reads from `mark`, or its fresh start. */
function dirsSince(
	mark: ReturnType<typeof journalNow>,
): readonly string[] | string {
	const read = journalSince(file, mark);
	return read === "started afresh" ? read : read.dirs;
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
		const first = journalNow(file);
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
		const mark = journalNow(file);
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

	it("moves a full journal aside, so its readers start afresh once", () => {
		writeFileSync(file, `${"/q/QEST-A\n".repeat(110_000)}`);
		const mark = journalNow(file);
		noteQuestWrite(file, "/q/QEST-B");
		expect(existsSync(`${file}.old`)).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("/q/QEST-B\n");
		expect(dirsSince(mark)).toBe("started afresh");
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
