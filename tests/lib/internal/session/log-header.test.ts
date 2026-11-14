import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	carriedOnIn,
	sessionLogHeader,
} from "../../../../lib/internal/session/log-header.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "log-header-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function logWith(name: string, header: unknown, rest = ""): string {
	const path = join(dir, name);
	writeFileSync(path, `${JSON.stringify(header)}\n${rest}`);
	return path;
}

describe("sessionLogHeader", () => {
	it("reads the id, folder and parent from the first line only", () => {
		const path = logWith(
			"a.jsonl",
			{ type: "session", id: "s2", cwd: "/w", parentSession: "/p.jsonl" },
			`${JSON.stringify({ type: "message", id: "e1" })}\n`,
		);
		expect(sessionLogHeader(path)).toEqual({
			id: "s2",
			cwd: "/w",
			parentSession: "/p.jsonl",
		});
	});

	it("reads a header longer than its first read, and one with no line after it", () => {
		const cwd = `/w/${"x".repeat(6000)}`;
		const long = logWith("long.jsonl", { id: "s5", cwd }, "{}\n");
		expect(sessionLogHeader(long)).toEqual({ id: "s5", cwd });

		const path = join(dir, "alone.jsonl");
		writeFileSync(path, JSON.stringify({ id: "s6" }));
		expect(sessionLogHeader(path)).toEqual({ id: "s6" });
	});

	it("answers nothing for a first line past the most it reads", () => {
		const cwd = `/w/${"x".repeat(70 * 1024)}`;
		const huge = logWith("huge.jsonl", { id: "s7", cwd }, "{}\n");
		expect(sessionLogHeader(huge)).toBeUndefined();
	});

	it("answers nothing for a missing log or a first line without an id", () => {
		expect(sessionLogHeader(join(dir, "none.jsonl"))).toBeUndefined();
		expect(
			sessionLogHeader(logWith("b.jsonl", { type: "session" })),
		).toBeUndefined();
	});
});

describe("carriedOnIn", () => {
	it("names the session whose log names this log as its parent", () => {
		const target = logWith("c.jsonl", {
			id: "s2",
			parentSession: "/old.jsonl",
		});
		expect(carriedOnIn(target, "/old.jsonl")).toBe("s2");
	});

	it("names nothing for another conversation's log, or with no log to compare", () => {
		const other = logWith("d.jsonl", {
			id: "s3",
			parentSession: "/else.jsonl",
		});
		const orphan = logWith("e.jsonl", { id: "s4" });
		expect(carriedOnIn(other, "/old.jsonl")).toBeUndefined();
		expect(carriedOnIn(orphan, "/old.jsonl")).toBeUndefined();
		expect(carriedOnIn(undefined, "/old.jsonl")).toBeUndefined();
		expect(carriedOnIn(other, undefined)).toBeUndefined();
	});
});
