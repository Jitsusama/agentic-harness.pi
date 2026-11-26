/**
 * A write over a file the conversation hasn't wholly read, or that
 * changed since it did, is refused; the same write sent again over the
 * same file goes through; a file it read whole or wrote, or a new one,
 * is written; and the reads it saw last through a reload, not a new
 * conversation.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import unreadWriteInterceptor from "../../../extensions/unread-write-interceptor/index.ts";
import { forgetRedirects } from "../../../lib/guardian/apply.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

let dir: string;
let on: Map<string, Handler>;
let calls = 0;

/** A conversation's context, by its session id. */
const conversation = (id = "s1") => ({
	cwd: dir,
	sessionManager: { getSessionId: () => id },
});

/** A fresh load of the extension, as a reload makes. */
const load = () => {
	on = new Map();
	const pi = { on: (name: string, handler: Handler) => on.set(name, handler) };
	unreadWriteInterceptor(pi as unknown as ExtensionAPI);
};

/** The conversation ending, as pi says it. */
const shutdown = (reason: string) =>
	on.get("session_shutdown")?.(
		{ type: "session_shutdown", reason },
		conversation(),
	);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "unread-write-"));
	forgetRedirects();
	load();
});

afterEach(async () => {
	await shutdown("quit");
	forgetRedirects();
	rmSync(dir, { recursive: true, force: true });
});

/** What the guard answers a write of `path`, with content of its own each time. */
const write = (path: string) => {
	calls += 1;
	return on.get("tool_call")?.(
		{
			type: "tool_call",
			toolCallId: `w${calls}`,
			toolName: "write",
			input: { path, content: `written ${calls}\n` },
		},
		conversation(),
	);
};

interface Call {
	readonly input?: Record<string, unknown>;
	readonly details?: unknown;
	readonly isError?: boolean;
	/** What happens to the file between the call and its result. */
	readonly meanwhile?: () => void;
}

/** A file tool's call of `path`, from its start to its end. */
const ran = async (toolName: string, path: string, call: Call = {}) => {
	calls += 1;
	const toolCallId = `r${calls}`;
	const input = { path, ...call.input };
	await on.get("tool_call")?.(
		{ type: "tool_call", toolCallId, toolName, input },
		conversation(),
	);
	call.meanwhile?.();
	await on.get("tool_result")?.(
		{
			type: "tool_result",
			toolCallId,
			toolName,
			input,
			content: [{ type: "text", text: "" }],
			isError: call.isError ?? false,
			details: call.details,
		},
		conversation(),
	);
};

const refused = (pattern: RegExp) => ({
	block: true,
	reason: expect.stringMatching(pattern),
});

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
			await on.get("tool_call")?.(same, conversation()),
			"refused, saying to read it first",
		).toMatchObject(refused(/hasn't read it/));
		expect(
			await on.get("tool_call")?.(same, conversation()),
			"the same write again is the agent's override",
		).toBeUndefined();
	});

	it("goes ahead once the conversation has read it whole", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ran("read", "notes.md");

		expect(await write("notes.md"), "a file it read").toBeUndefined();
	});

	it("is refused when the file changed since the conversation read it", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ran("read", "notes.md");
		writeFileSync(join(dir, "notes.md"), "kept, and more besides\n");

		expect(await write("notes.md"), "changed under it").toMatchObject(
			refused(/has changed since/),
		);
	});

	it("is refused again when the file changes again after an override was left unspent", async () => {
		const file = join(dir, "notes.md");
		writeFileSync(file, "one\n");
		await ran("read", "notes.md");
		writeFileSync(file, "two, from elsewhere\n");
		expect(await write("notes.md"), "first change").toMatchObject({
			block: true,
		});
		await ran("read", "notes.md");
		expect(await write("notes.md"), "read again, so it goes").toBeUndefined();
		await ran("write", "notes.md");
		writeFileSync(file, "three, from elsewhere again\n");

		expect(
			await write("notes.md"),
			"an override the agent never used covers no later change",
		).toMatchObject(refused(/has changed since/));
	});

	it("goes ahead over a file the conversation wrote itself, or edited after reading it", async () => {
		writeFileSync(join(dir, "a.ts"), "one\n");
		await ran("write", "a.ts");
		writeFileSync(join(dir, "b.ts"), "two\n");
		await ran("read", "b.ts");
		await ran("edit", "b.ts", {
			meanwhile: () => writeFileSync(join(dir, "b.ts"), "two, edited\n"),
		});

		expect(await write("a.ts"), "written").toBeUndefined();
		expect(await write("b.ts"), "read, then edited").toBeUndefined();
	});

	it("is refused when the conversation only edited it, since an edit shows a part", async () => {
		writeFileSync(join(dir, "b.ts"), "two\n");
		await ran("edit", "b.ts", {
			meanwhile: () => writeFileSync(join(dir, "b.ts"), "two, edited\n"),
		});

		expect(await write("b.ts"), "edited unread").toMatchObject(
			refused(/hasn't read it/),
		);
	});

	it("is refused when the conversation read only a part of it", async () => {
		writeFileSync(join(dir, "sliced.md"), "one\ntwo\n");
		writeFileSync(join(dir, "cut.md"), "long\n");
		await ran("read", "sliced.md", { input: { offset: 2 } });
		await ran("read", "cut.md", {
			details: { truncation: { truncated: true } },
		});

		expect(await write("sliced.md"), "a slice").toMatchObject({ block: true });
		expect(await write("cut.md"), "a truncated read").toMatchObject({
			block: true,
		});
	});

	it("is refused when the file changed while it was being read", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ran("read", "notes.md", {
			meanwhile: () =>
				writeFileSync(join(dir, "notes.md"), "changed mid-read\n"),
		});

		expect(
			await write("notes.md"),
			"what it read is not what is there",
		).toMatchObject({ block: true });
	});

	it("counts no read that failed", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ran("read", "notes.md", { isError: true });

		expect(await write("notes.md"), "a failed read saw nothing").toMatchObject({
			block: true,
		});
	});

	it("goes ahead where no file is yet", async () => {
		expect(await write("new.md"), "a new file").toBeUndefined();
	});

	it("keeps what the conversation read through a reload", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ran("read", "notes.md");
		await shutdown("reload");
		load();

		expect(await write("notes.md"), "read before the reload").toBeUndefined();
	});

	it("forgets what was read when the conversation is replaced", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ran("read", "notes.md");
		await shutdown("new");
		load();

		expect(
			await write("notes.md"),
			"a new conversation read nothing",
		).toMatchObject({ block: true });
	});
});
