/**
 * A write over a file the conversation hasn't wholly read, or that
 * changed since it did, is refused; the same write sent again over the
 * same file goes through; a file it read whole or wrote, or a new one,
 * is written; and the reads it saw last through a reload, not a new
 * conversation.
 */

import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHost } from "../../../lib/core/session/host.ts";
import { withSession } from "../../../lib/core/session/identity.ts";
import { forgetRedirects } from "../../../lib/guardian/apply.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

let dir: string;
let on: Map<string, Handler>;
let calls = 0;
/** The conversation the next calls are made in. */
let speaking = "s1";

/** A conversation's context, by its session id. */
const conversation = (id = speaking) => ({
	cwd: dir,
	sessionManager: { getSessionId: () => id },
});

/**
 * A fresh load of the extension, as a reload makes: its module evaluated
 * again, as pi does, so nothing it keeps only in itself survives.
 */
const load = async () => {
	vi.resetModules();
	const { default: unreadWriteInterceptor } = await import(
		"../../../extensions/unread-write-interceptor/index.ts"
	);
	on = new Map();
	const pi = { on: (name: string, handler: Handler) => on.set(name, handler) };
	unreadWriteInterceptor(pi as unknown as ExtensionAPI);
};

/**
 * An event pi sends the extension, in the conversation speaking now,
 * run inside it as a host runs every hook.
 */
const send = (name: string, event: object, ctx: object = conversation()) =>
	withSession(speaking, () => on.get(name)?.({ type: name, ...event }, ctx));

/** The conversation ending, as pi says it. */
const shutdown = (reason: string) => send("session_shutdown", { reason });

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "unread-write-"));
	speaking = "s1";
	forgetRedirects();
	await load();
});

afterEach(async () => {
	speaking = "s1";
	await shutdown("quit");
	withSession(speaking, forgetRedirects);
	rmSync(dir, { recursive: true, force: true });
});

/** What the guard answers a write of `path`, with content of its own each time. */
const write = (path: string, ctx: object = conversation()) => {
	calls += 1;
	return send(
		"tool_call",
		{
			toolCallId: `w${calls}`,
			toolName: "write",
			input: { path, content: `written ${calls}\n` },
		},
		ctx,
	);
};

interface Call {
	readonly input?: Record<string, unknown>;
	readonly details?: unknown;
	readonly isError?: boolean;
	/** What happens to the file between the call and its result. */
	readonly meanwhile?: () => void;
}

/** A file tool's call of `path`, sent but not yet run. */
const called = async (toolName: string, path: string, call: Call = {}) => {
	calls += 1;
	const toolCallId = `r${calls}`;
	const input = { path, ...call.input };
	await send("tool_call", { toolCallId, toolName, input });
	return async () => {
		call.meanwhile?.();
		await send("tool_result", {
			toolCallId,
			toolName,
			input,
			content: [{ type: "text", text: "" }],
			isError: call.isError ?? false,
			details: call.details,
		});
		await send("tool_execution_end", { toolCallId, toolName });
	};
};

/** A file tool's call of `path`, from its start to its end. */
const ran = async (toolName: string, path: string, call: Call = {}) => {
	const finish = await called(toolName, path, call);
	await finish();
};

/** An edit of `path` replacing `oldText` with `newText`, as the tool does it. */
const edit = (path: string, oldText: string, newText: string): Call => ({
	input: { edits: [{ oldText, newText }] },
	meanwhile: () => {
		const file = join(dir, path);
		writeFileSync(file, readFileSync(file, "utf8").replace(oldText, newText));
	},
});

/** A write of `content` to `path`, as the tool does it. */
const wrote = (path: string, content: string): Call => ({
	input: { content },
	meanwhile: () => writeFileSync(join(dir, path), content),
});

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
		await ran("write", "notes.md", wrote("notes.md", "mine\n"));
		writeFileSync(file, "three, from elsewhere again\n");

		expect(
			await write("notes.md"),
			"an override the agent never used covers no later change",
		).toMatchObject(refused(/has changed since/));
	});

	it("goes ahead over a file the conversation wrote itself", async () => {
		await ran("write", "a.ts", wrote("a.ts", "one\n"));
		// No override waits: the first write met no file, so nothing was refused.
		forgetRedirects();

		expect(await write("a.ts"), "written").toBeUndefined();
	});

	it("is refused when something else changed the file as the conversation wrote it", async () => {
		await ran("write", "a.ts", {
			input: { content: "mine\n" },
			meanwhile: () => writeFileSync(join(dir, "a.ts"), "mine\ntheirs\n"),
		});

		expect(await write("a.ts"), "theirs is unseen").toMatchObject({
			block: true,
		});
	});

	it("goes ahead over a file the conversation edited after reading it", async () => {
		writeFileSync(join(dir, "b.ts"), "two\n");
		await ran("read", "b.ts");
		await ran("edit", "b.ts", edit("b.ts", "two", "two, edited"));

		expect(await write("b.ts"), "read, then edited").toBeUndefined();
	});

	it("goes ahead after edits sent together, each run after the one before", async () => {
		writeFileSync(join(dir, "b.ts"), "one two\n");
		await ran("read", "b.ts");
		const first = await called("edit", "b.ts", edit("b.ts", "one", "uno!"));
		const second = await called("edit", "b.ts", edit("b.ts", "two", "dos!!"));
		await first();
		await second();

		expect(await write("b.ts"), "both edits its own").toBeUndefined();
	});

	it("is refused when the file changed between the conversation's read and its edit", async () => {
		writeFileSync(join(dir, "b.ts"), "two\n");
		await ran("read", "b.ts");
		appendFileSync(join(dir, "b.ts"), "theirs\n");
		await ran("edit", "b.ts", edit("b.ts", "two", "deux"));

		expect(await write("b.ts"), "theirs is unseen").toMatchObject({
			block: true,
		});
	});

	it("is refused when the file changed after the edit was sent and before it ran", async () => {
		writeFileSync(join(dir, "b.ts"), "two\n");
		await ran("read", "b.ts");
		const editing = edit("b.ts", "two", "deux");
		await ran("edit", "b.ts", {
			...editing,
			meanwhile: () => {
				appendFileSync(join(dir, "b.ts"), "theirs\n");
				editing.meanwhile?.();
			},
		});

		expect(await write("b.ts"), "theirs is unseen").toMatchObject({
			block: true,
		});
	});

	it("is refused when the conversation only edited it, since an edit shows a part", async () => {
		writeFileSync(join(dir, "b.ts"), "two\n");
		await ran("edit", "b.ts", edit("b.ts", "two", "two, edited"));

		expect(await write("b.ts"), "edited unread").toMatchObject(
			refused(/hasn't read it/),
		);
	});

	it("is refused when the conversation read only a part of it", async () => {
		writeFileSync(join(dir, "tail.md"), "one\ntwo\n");
		writeFileSync(join(dir, "head.md"), "one\ntwo\n");
		writeFileSync(join(dir, "cut.md"), "long\n");
		await ran("read", "tail.md", { input: { offset: 2 } });
		await ran("read", "head.md", { input: { limit: 1 } });
		// pi's read tool puts truncation in its details only when it cut the text.
		await ran("read", "cut.md", {
			details: {
				truncation: { truncated: true, truncatedBy: "lines", outputLines: 1 },
			},
		});

		expect(await write("tail.md"), "from an offset").toMatchObject({
			block: true,
		});
		expect(await write("head.md"), "to a limit").toMatchObject({
			block: true,
		});
		expect(await write("cut.md"), "a truncated read").toMatchObject({
			block: true,
		});
	});

	it("goes ahead over a read from its first line, and one that looked again at a part", async () => {
		writeFileSync(join(dir, "top.md"), "one\ntwo\n");
		writeFileSync(join(dir, "again.md"), "one\ntwo\n");
		await ran("read", "top.md", { input: { offset: 1 } });
		await ran("read", "again.md");
		await ran("read", "again.md", { input: { offset: 2, limit: 1 } });

		expect(await write("top.md"), "from line one").toBeUndefined();
		expect(await write("again.md"), "still the file it read").toBeUndefined();
	});

	it("forgets what was read once the conversation is compacted or moved in its tree", async () => {
		writeFileSync(join(dir, "compacted.md"), "kept\n");
		writeFileSync(join(dir, "moved.md"), "kept\n");
		await ran("read", "compacted.md");
		await send("session_compact", {});
		await ran("read", "moved.md");
		await send("session_tree", {});

		expect(await write("compacted.md"), "compacted away").toMatchObject(
			refused(/hasn't read it/),
		);
		expect(await write("moved.md"), "on another branch").toMatchObject(
			refused(/hasn't read it/),
		);
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
		await load();

		expect(await write("notes.md"), "read before the reload").toBeUndefined();
	});

	it("forgets what was read when the conversation is replaced", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ran("read", "notes.md");
		await shutdown("new");
		await load();

		expect(
			await write("notes.md"),
			"a new conversation read nothing",
		).toMatchObject({ block: true });
	});
});

describe("a write in a host", () => {
	let uninstall: () => void;

	// Taken down before the suite's own hooks, which run unhosted.
	afterEach(() => uninstall());

	beforeEach(() => {
		uninstall = installHost({
			kind: "pi-durable",
			key: "unread-write-host",
			owner: { pid: 1, startedAt: 1, bootId: "b", startTicks: 1 },
			holds: () => "idle",
			env: () => ({
				get: () => undefined,
				set: () => undefined,
				delete: () => undefined,
				snapshot: () => ({}),
			}),
			hints: () => ({}),
			close: () => {},
			stamp: () => {},
		});
	});

	it("goes ahead only in the conversation that read the file", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ran("read", "notes.md");
		speaking = "s2";

		expect(
			await write("notes.md"),
			"another conversation read nothing",
		).toMatchObject(refused(/hasn't read it/));
		speaking = "s1";
		expect(await write("notes.md"), "the one that read it").toBeUndefined();
	});

	it("is refused from a context that can't say which conversation it is", async () => {
		writeFileSync(join(dir, "notes.md"), "kept\n");
		await ran("read", "notes.md");
		const stale = {
			cwd: dir,
			sessionManager: {
				getSessionId: () => {
					throw new Error("this context's session was replaced");
				},
			},
		};

		expect(await write("notes.md", stale), "no stamps to go by").toMatchObject(
			refused(/hasn't read it/),
		);
	});
});
