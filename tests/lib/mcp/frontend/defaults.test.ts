import { describe, expect, it, vi } from "vitest";
import {
	defaultWriteSignal,
	identityShape,
	makeDefaultWrap,
	makeTruncatingShape,
	toAgentContent,
} from "../../../../lib/mcp/frontend/defaults.ts";
import { CANCELLED_TEXT } from "../../../../lib/mcp/render/result.ts";
import type {
	McpContent,
	McpTool,
	McpToolResult,
} from "../../../../lib/mcp/types.ts";

function tool(name: string, annotations?: McpTool["annotations"]): McpTool {
	return {
		serverId: "s",
		name,
		description: "",
		inputSchema: { type: "object" },
		annotations,
		raw: {},
	};
}

function result(
	content: McpContent[],
	extra: Partial<McpToolResult> = {},
): McpToolResult {
	return { content, ...extra };
}

describe("identityShape", () => {
	it("returns the content unchanged", () => {
		const content: McpContent[] = [{ type: "text", text: "x" }];
		expect(identityShape(result(content))).toEqual(content);
	});
});

describe("makeTruncatingShape", () => {
	it("caps a long text block and appends a marker", () => {
		const shape = makeTruncatingShape({ maxLines: 2, maxBytes: 1000 });
		const [block] = shape(result([{ type: "text", text: "1\n2\n3\n4" }]));
		expect(block?.type).toBe("text");
		expect((block as { text: string }).text).toContain("Truncated");
	});

	it("passes a short block and non-text through untouched", () => {
		const shape = makeTruncatingShape({ maxLines: 40, maxBytes: 1000 });
		const content: McpContent[] = [
			{ type: "text", text: "short" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		];
		expect(shape(result(content))).toEqual(content);
	});
});

describe("defaultWriteSignal", () => {
	it("uses a read-only or destructive hint when present, ignoring the name", () => {
		expect(
			defaultWriteSignal(tool("delete_everything", { readOnlyHint: true })),
			"a read-only hint makes even delete_everything a read",
		).toBe(false);
		expect(
			defaultWriteSignal(tool("harmless", { destructiveHint: true })),
			"a destructive hint makes even harmless a write",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("harmless", { readOnlyHint: false })),
			"a read-only hint of false makes even harmless a write",
		).toBe(true);
		expect(
			defaultWriteSignal(
				tool("delete_everything", {
					readOnlyHint: true,
					destructiveHint: true,
				}),
			),
			"a read-only hint decides even beside a destructive one",
		).toBe(false);
		expect(
			defaultWriteSignal(
				tool("harmless", { readOnlyHint: false, destructiveHint: false }),
			),
			"a non-read-only tool that only adds is still a write",
		).toBe(true);
	});

	it("gates a destructive hint of false with no read-only hint", () => {
		// The spec reads a missing read-only hint as false, so this says
		// the tool writes, only by adding: a post or a create.
		expect(
			defaultWriteSignal(tool("post_comment", { destructiveHint: false })),
			"post_comment that only adds is a write",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("harmless", { destructiveHint: false })),
			"the hint decides, not the name",
		).toBe(true);
	});

	it("reads a hint that isn't a boolean as no hint", () => {
		// The connection passes a server's annotations on unchecked, so a
		// string can arrive where the spec says a boolean goes.
		const said = { readOnlyHint: "true" } as unknown as McpTool["annotations"];
		expect(
			defaultWriteSignal(tool("delete_item", said)),
			"a string read-only hint leaves delete_item a write, by its verb",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("search_items", said)),
			"a string read-only hint leaves search_items a read, by its verb",
		).toBe(false);
		const destructive = {
			destructiveHint: "true",
		} as unknown as McpTool["annotations"];
		expect(
			defaultWriteSignal(tool("harmless", destructive)),
			"a string destructive hint leaves harmless a read, by its name",
		).toBe(false);
	});

	it("falls back to a name-verb match when the annotations carry no hint", () => {
		expect(
			defaultWriteSignal(tool("delete_everything", {})),
			"empty annotations leave delete_everything a write, by its verb",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("delete_everything", { idempotentHint: true })),
			"an idempotent hint alone says nothing of writing",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("search_items", { idempotentHint: true })),
			"nor does it make search_items a write",
		).toBe(false);
		expect(
			defaultWriteSignal(tool("grokt_search_code", { openWorldHint: true })),
			"grokt_search_code, with no read or write hint, is a read by its verb",
		).toBe(false);
	});

	it("falls back to a name-verb match when no annotations exist", () => {
		expect(
			defaultWriteSignal(tool("slack_post")),
			"slack_post, by its post verb, is a write",
		).toBe(true);
		expect(
			defaultWriteSignal(tool("grokt_search_code")),
			"grokt_search_code, by its search verb, is a read",
		).toBe(false);
	});
});

describe("toAgentContent", () => {
	it("maps text and image blocks", () => {
		const content: McpContent[] = [
			{ type: "text", text: "hi" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		];
		expect(toAgentContent(result(content))).toEqual([
			{ type: "text", text: "hi" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
	});
});

describe("makeDefaultWrap", () => {
	const ctx = {} as never;
	const okResult = result([{ type: "text", text: "done" }]);

	it("calls straight through when the tool is not a write", async () => {
		const invoke = vi.fn(async () => okResult);
		const wrapped = makeDefaultWrap({ writeSignal: () => false })(
			invoke,
			tool("read_thing"),
		);
		const out = await wrapped({ a: 1 }, ctx);
		expect(invoke).toHaveBeenCalledOnce();
		expect(out.content).toEqual([{ type: "text", text: "done" }]);
	});

	it("invokes with the approved args when the gate approves", async () => {
		const invoke = vi.fn(async () => okResult);
		const showGate = vi.fn(async () => ({
			approved: true as const,
			data: { a: 2 },
		}));
		const wrapped = makeDefaultWrap({ writeSignal: () => true, showGate })(
			invoke,
			tool("write_thing"),
		);
		await wrapped({ a: 1 }, ctx);
		expect(invoke).toHaveBeenCalledWith({ a: 2 }, undefined);
	});

	it("returns the cancel sentinel and does not invoke when cancelled", async () => {
		const invoke = vi.fn(async () => okResult);
		const showGate = vi.fn(async () => null);
		const wrapped = makeDefaultWrap({ writeSignal: () => true, showGate })(
			invoke,
			tool("write_thing"),
		);
		const out = await wrapped({ a: 1 }, ctx);
		expect(invoke).not.toHaveBeenCalled();
		expect(out.content).toEqual([{ type: "text", text: CANCELLED_TEXT }]);
	});

	it("returns the redirect note and does not invoke when redirected", async () => {
		const invoke = vi.fn(async () => okResult);
		const showGate = vi.fn(async () => ({
			approved: false as const,
			redirect: "do it differently",
		}));
		const wrapped = makeDefaultWrap({ writeSignal: () => true, showGate })(
			invoke,
			tool("write_thing"),
		);
		const out = await wrapped({ a: 1 }, ctx);
		expect(invoke).not.toHaveBeenCalled();
		expect(JSON.stringify(out.content)).toContain("do it differently");
	});

	it("passes an errored transport result through for the core to handle", async () => {
		const invoke = vi.fn(async () =>
			result([{ type: "text", text: "boom" }], { isError: true }),
		);
		const wrapped = makeDefaultWrap({ writeSignal: () => false })(
			invoke,
			tool("read_thing"),
		);
		const out = await wrapped({}, ctx);
		expect(out).toMatchObject({ isError: true });
		expect(out.content).toEqual([{ type: "text", text: "boom" }]);
	});
});
