/**
 * One scrub of a tool's whole answer, read by the command the call ran:
 * the secret-scrub extension and a host's tool round both answer with it,
 * so a conversation that loads no extension is scrubbed the same way.
 *
 * Every credential here is made as the test runs, so the repository never
 * holds a string shaped like a live one.
 */

import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import secretScrubInterceptor from "../../../extensions/secret-scrub-interceptor/index.ts";
import {
	scrubOptionsOf,
	scrubToolResult,
} from "../../../lib/internal/secrets.ts";

const fresh = () => `z9${randomBytes(19).toString("hex")}`;
const MARK = "[secret scrubbed: OP_SESSION_ab12]";
const awsKey = `AK${"IA"}${"QQQQWWWWEEEERRRR"}`;

function dumpOf(value: string) {
	return {
		content: [
			{ type: "text", text: `OP_SESSION_ab12=${value}` },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		],
		details: { tail: `OP_SESSION_ab12=${value}` },
		structuredContent: { output: `OP_SESSION_ab12=${value}`, exitCode: 0 },
	};
}

describe("a tool's answer scrubbed whole", () => {
	it("puts a printed environment's every value out of sight, in all three fields", () => {
		const value = fresh();
		const scrubbed = scrubToolResult(dumpOf(value), { command: "printenv" });
		expect(JSON.stringify(scrubbed)).not.toContain(value);
		expect(scrubbed).toEqual({
			content: [
				{ type: "text", text: `OP_SESSION_ab12=${MARK}` },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			details: { tail: `OP_SESSION_ab12=${MARK}` },
			structuredContent: { output: `OP_SESSION_ab12=${MARK}`, exitCode: 0 },
		});
	});

	it("reads a command that prints no environment as ordinary output", () => {
		const answer = dumpOf(fresh());
		expect(scrubToolResult(answer, { command: "cat notes.txt" })).toBe(
			undefined,
		);
		const keyed = {
			content: [{ type: "text", text: `found ${awsKey}` }],
		};
		expect(scrubToolResult(keyed, { command: "cat notes.txt" })).toEqual({
			content: [
				{ type: "text", text: "found [secret scrubbed: AWS access key]" },
			],
		});
	});

	it("names only the fields the answer has", () => {
		const scrubbed = scrubToolResult(
			{ content: [{ type: "text", text: `OP_SESSION_ab12=${fresh()}` }] },
			{ command: "env" },
		);
		expect(Object.keys(scrubbed ?? {})).toEqual(["content"]);
	});

	it("is undefined for an answer with nothing to hide", () => {
		expect(
			scrubToolResult(
				{ content: [{ type: "text", text: "all clean" }], details: { n: 1 } },
				{ command: "printenv" },
			),
		).toBe(undefined);
	});

	it("reads the command from any call's input, and none from one without", () => {
		expect(scrubOptionsOf({ command: "printenv HOME" })).toEqual({
			environment: true,
		});
		expect(scrubOptionsOf({ command: "ls" })).toEqual({ environment: false });
		for (const input of [undefined, null, "printenv", { command: 3 }]) {
			expect(scrubOptionsOf(input)).toEqual({ environment: false });
		}
	});

	it("is what the secret-scrub extension answers with", async () => {
		let handler: ((event: unknown) => Promise<unknown>) | undefined;
		const pi = {
			on: (_name: string, on: (event: unknown) => Promise<unknown>) => {
				handler = on;
			},
		};
		secretScrubInterceptor(pi as unknown as ExtensionAPI);
		const value = fresh();
		const answer = dumpOf(value);
		const input = { command: "printenv" };
		const fromExtension = await handler?.({
			type: "tool_result",
			toolCallId: "1",
			toolName: "bash",
			input,
			isError: false,
			...answer,
		});
		expect(fromExtension).toEqual(scrubToolResult(answer, input));
	});
});
