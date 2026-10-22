/**
 * An edit spelling a character as its `\uXXXX` escape matches the file
 * holding the character, and writes the character, but only where the
 * file shows that is what was meant.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readEscapes,
	unescaped,
} from "../../extensions/edit-escape-interceptor/escapes.ts";
import editEscapeInterceptor from "../../extensions/edit-escape-interceptor/index.ts";

describe("reading an edit's escapes", () => {
	it("reads them where the old text only matches that way, the new text too", () => {
		const edits = [
			{ oldText: "host name \\u2192 port", newText: "host \\u2192 port" },
		];

		expect(readEscapes("a host name → port line", edits)).toBe(1);
		expect(edits).toEqual([
			{ oldText: "host name → port", newText: "host → port" },
		]);
	});

	it("leaves an old text that matches as written, as source code may", () => {
		const edits = [
			{ oldText: 'ARROW = "\\u2192"', newText: 'ARROW = "\\u21d2"' },
		];

		// The file holds both spellings, so either reading would match.
		const content = 'const ARROW = "\\u2192"; // ARROW = "→"';

		expect(readEscapes(content, edits)).toBe(0);
		expect(edits).toEqual([
			{ oldText: 'ARROW = "\\u2192"', newText: 'ARROW = "\\u21d2"' },
		]);
	});

	it("keeps the new text's escapes where the file holds some as text", () => {
		const content = 'HISTORY § 71\nconst S = "\\u00a7";\n';
		const edits = [
			{ oldText: "HISTORY \\u00a7 71", newText: "HISTORY \\u00a7 72" },
		];

		readEscapes(content, edits);

		expect(edits).toEqual([
			{ oldText: "HISTORY § 71", newText: "HISTORY \\u00a7 72" },
		]);
	});

	it("leaves an edit that matches neither way for the edit tool to report", () => {
		const edits = [{ oldText: "gone \\u2192 here", newText: "x" }];

		expect(readEscapes("nothing like it", edits)).toBe(0);
		expect(edits[0]?.oldText).toBe("gone \\u2192 here");
	});

	it("makes one character of a surrogate pair", () => {
		expect(unescaped("\\ud83d\\ude80 launch")).toBe("🚀 launch");
	});
});

describe("an edit call", () => {
	let dir: string;
	let handler: (event: unknown, ctx: unknown) => Promise<unknown>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "edit-escape-"));
		const pi = {
			on: (name: string, listener: typeof handler) => {
				if (name === "tool_call") handler = listener;
			},
		};
		editEscapeInterceptor(pi as unknown as ExtensionAPI);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const call = (toolName: string, path: string, oldText: string) => ({
		type: "tool_call",
		toolCallId: "t1",
		toolName,
		input: { path, edits: [{ oldText, newText: "pool \\u2192 peers" }] },
	});

	it("is changed before it runs, against the file it names", async () => {
		writeFileSync(join(dir, "notes.md"), "pool → hosts\n");
		const event = call("edit", "notes.md", "pool \\u2192 hosts");

		await handler(event, { cwd: dir });

		expect(event.input.edits).toEqual([
			{ oldText: "pool → hosts", newText: "pool → peers" },
		]);
	});

	it("is left as it is when the file cannot be read", async () => {
		const event = call("edit", "missing.md", "pool \\u2192 hosts");

		await handler(event, { cwd: dir });

		expect(event.input.edits[0]?.oldText).toBe("pool \\u2192 hosts");
	});

	it("is only an edit's: another tool's input is not touched", async () => {
		writeFileSync(join(dir, "notes.md"), "pool → hosts\n");
		const event = call("write", "notes.md", "pool \\u2192 hosts");

		await handler(event, { cwd: dir });

		expect(event.input.edits[0]?.oldText).toBe("pool \\u2192 hosts");
	});
});
