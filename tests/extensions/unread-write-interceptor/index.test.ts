/**
 * A write over a file the conversation hasn't read, or that changed
 * since it did, is refused once; a file it read, wrote or edited, or a
 * new one, is written; and each conversation keeps its own reads.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import unreadWriteInterceptor from "../../../extensions/unread-write-interceptor/index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

let dir: string;
let on: Map<string, Handler>;
let calls = 0;

/** A conversation's context, by its session id. */
const conversation = (id: string) => ({
	cwd: dir,
	sessionManager: { getSessionId: () => id },
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "unread-write-"));
	on = new Map();
	const pi = { on: (name: string, handler: Handler) => on.set(name, handler) };
	unreadWriteInterceptor(pi as unknown as ExtensionAPI);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** What the guard answers a write of `path`, with content of its own each time. */
const write = (path: string, id = "s1") => {
	calls += 1;
	return on.get("tool_call")?.(
		{
			type: "tool_call",
			toolCallId: `w${calls}`,
			toolName: "write",
			input: { path, content: `written ${calls}\n` },
		},
		conversation(id),
	);
};

/** A file tool's call of `path` ending, as it ended. */
const ended = (toolName: string, path: string, id = "s1", isError = false) =>
	on.get("tool_result")?.(
		{
			type: "tool_result",
			toolCallId: `r${calls}`,
			toolName,
			input: { path },
			content: [{ type: "text", text: "" }],
			isError,
			details: undefined,
		},
		conversation(id),
	);

describe("a write over a file", () => {
	it("is refused when the conversation never read it, and goes through sent again", async () => {
		writeFileSync(join(dir, "asks.jsonl"), '{"ask":1}\n');
		const same = {
			type: "tool_call",
			toolCallId: "w",
			toolName: "write",
			input: { path: "asks.jsonl", content: "{}\n" },
		};

		expect(
			await on.get("tool_call")?.(same, conversation("s1")),
			"refused, saying to read it first",
		).toMatchObject({
			block: true,
			reason: expect.stringMatching(/hasn't read it/),
		});
		expect(
			await on.get("tool_call")?.(same, conversation("s1")),
			"the same write again is the agent's override",
		).toBeUndefined();
	});

	it("goes ahead once the conversation has read it", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ended("read", "notes.md");

		expect(await write("notes.md"), "a file it read").toBeUndefined();
	});

	it("is refused when the file changed since the conversation read it", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ended("read", "notes.md");
		writeFileSync(join(dir, "notes.md"), "kept, and more besides\n");

		expect(await write("notes.md"), "changed under it").toMatchObject({
			block: true,
			reason: expect.stringMatching(/has changed since/),
		});
	});

	it("goes ahead over a file the conversation wrote or edited itself", async () => {
		writeFileSync(join(dir, "a.ts"), "one\n");
		await ended("write", "a.ts");
		writeFileSync(join(dir, "b.ts"), "two\n");
		await ended("edit", "b.ts");

		expect(await write("a.ts"), "written").toBeUndefined();
		expect(await write("b.ts"), "edited").toBeUndefined();
	});

	it("counts no read that failed", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ended("read", "notes.md", "s1", true);

		expect(await write("notes.md"), "a failed read saw nothing").toMatchObject({
			block: true,
		});
	});

	it("goes ahead where no file is yet", async () => {
		expect(await write("new.md"), "a new file").toBeUndefined();
	});

	it("keeps each conversation's reads its own", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ended("read", "notes.md", "s1");

		expect(
			await write("notes.md", "s2"),
			"another conversation never read it",
		).toMatchObject({ block: true });
	});
});
