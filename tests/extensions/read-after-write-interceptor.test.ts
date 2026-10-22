/**
 * A read sent beside an edit or write of the same file answers from the
 * file once the write has landed, never from a file caught half written.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import readAfterWriteInterceptor from "../../extensions/read-after-write-interceptor/index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

let dir: string;
let on: Map<string, Handler>;
let ctx: { cwd: string };

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "read-after-write-"));
	on = new Map();
	const pi = { on: (name: string, handler: Handler) => on.set(name, handler) };
	readAfterWriteInterceptor(pi as unknown as ExtensionAPI);
	ctx = { cwd: dir };
	await on.get("session_start")?.({}, ctx);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const start = (toolCallId: string, toolName: string) =>
	on.get("tool_execution_start")?.(
		{
			type: "tool_execution_start",
			toolCallId,
			toolName,
			args: { path: "a.ts" },
		},
		ctx,
	);

const result = (
	toolCallId: string,
	toolName: string,
	text: string,
	isError = toolName === "read",
) =>
	on.get("tool_result")?.(
		{
			type: "tool_result",
			toolCallId,
			toolName,
			input: { path: "a.ts" },
			content: [{ type: "text", text }],
			isError,
			details: undefined,
		},
		ctx,
	);

/** What a read of a file not yet made says. */
const MISSING = "ENOENT: no such file or directory, access 'a.ts'";

/** What a read caught mid-write says. */
const CAUGHT = "Offset 2 is beyond end of file (1 lines total)";

describe("a read beside a write of the same file", () => {
	it("answers from the file once the write announced before it lands", async () => {
		await start("edit", "edit");
		await start("read", "read");

		const answer = result("read", "read", CAUGHT);
		writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n");
		await result("edit", "edit", "Successfully replaced 1 block(s).");

		expect(await answer).toMatchObject({
			isError: false,
			content: [{ type: "text", text: expect.stringContaining("one\ntwo") }],
		});
	});

	it("waits for a write announced after it, too", async () => {
		await start("read", "read");
		await start("write", "write");

		const answer = result("read", "read", "");
		writeFileSync(join(dir, "a.ts"), "written\n");
		await result("write", "write", "Wrote a.ts.");

		expect(await answer).toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("written") }],
		});
	});

	it("is left alone when its write had landed before it was sent", async () => {
		await start("edit", "edit");
		await result("edit", "edit", "Successfully replaced 1 block(s).");
		await start("read", "read");

		expect(await result("read", "read", "one")).toBeUndefined();
	});
});

describe("a read beside a shell command", () => {
	it("waits for the command when it found no file, then reads what it made", async () => {
		await start("shot", "bash");
		await start("read", "read");

		const answer = result("read", "read", MISSING);
		writeFileSync(join(dir, "a.ts"), "taken\n");
		await result("shot", "bash", "done", false);

		expect(await answer).toMatchObject({
			isError: false,
			content: [{ type: "text", text: expect.stringContaining("taken") }],
		});
	});

	it("is left alone when it found its file", async () => {
		await start("shot", "bash");
		await start("read", "read");

		expect(await result("read", "read", "one", false)).toBeUndefined();
	});
});

describe("a read with no write beside it", () => {
	it("is left alone", async () => {
		await start("read", "read");

		expect(await result("read", "read", "one")).toBeUndefined();
	});
});
