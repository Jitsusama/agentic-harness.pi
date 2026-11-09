/**
 * Two conversations in one host each print a credential past the spill
 * limit of pi-durable's bash: the spill file, the answer and its
 * structured answer all reach the log scrubbed, and the scrub the host
 * applies to each streamed partial is pure and idempotent.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import secretScrubInterceptor from "../../extensions/secret-scrub-interceptor/index.ts";
import { installHost } from "../../lib/core/session/index.ts";
import { scrubSecrets } from "../../lib/internal/secrets.ts";
import { extensionRunner } from "../support/extension-runner.ts";

// Built from pieces so the repository never holds a key-shaped string.
const awsKey = (seed: string) =>
	`AK${"IA"}${seed.toUpperCase().padEnd(16, "Q").slice(0, 16)}`;
const MARK = "[secret scrubbed: AWS access key]";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function host() {
	cleanups.push(
		installHost({
			kind: "pi-durable",
			key: "scrub-host",
			owner: { pid: process.pid, startedAt: Date.now() },
			holds: () => "idle",
			env: () => {
				throw new Error("Scrub tests do not consume host env");
			},
			hints: () => ({}),
			close: () => {},
			stamp: () => {},
		}),
	);
}

/** A spill as pi-durable's bash leaves it: its own tmp- folder, a uuid name. */
function durableSpill(text: string): string {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-"));
	cleanups.push(() => fs.rmSync(folder, { recursive: true, force: true }));
	const file = path.join(folder, `pi-output-${randomUUID()}.log`);
	fs.writeFileSync(file, text, { mode: 0o600 });
	return file;
}

/** One conversation's bash answer: the key early (spilled only) and in the tail. */
async function conversation(seed: string) {
	const loaded = extensionRunner(secretScrubInterceptor, process.cwd());
	await loaded.start();
	const key = awsKey(seed);
	const tail = `tail ${key}`;
	const file = durableSpill(
		`early ${key}\n${"filler\n".repeat(3000)}${tail}\n`,
	);
	const result = await loaded.runner.emitToolResult({
		type: "tool_result",
		toolCallId: `call-${seed}`,
		toolName: "bash",
		input: { command: "print-key" },
		content: [{ type: "text", text: tail }],
		structuredContent: {
			output: tail,
			truncated: true,
			fullOutputPath: file,
			exitCode: 0,
		},
		details: undefined,
		isError: false,
	} as never);
	return { key, file, result };
}

describe("the scrub in a host", () => {
	it("scrubs each conversation's spill, answer and structured answer", async () => {
		host();
		const a = await conversation("alpha");
		const b = await conversation("bravo");
		for (const one of [a, b]) {
			const spilled = fs.readFileSync(one.file, "utf8");
			expect(spilled, "the spill file holds no key").not.toContain(one.key);
			expect(spilled.slice(0, `early ${MARK}\n`.length)).toBe(
				`early ${MARK}\n`,
			);
			expect(one.result).toMatchObject({
				content: [{ type: "text", text: `tail ${MARK}` }],
				structuredContent: { output: `tail ${MARK}`, fullOutputPath: one.file },
			});
		}
	});

	it("gives the host a pure, idempotent scrub for each streamed partial", () => {
		const key = awsKey("charlie");
		// pi-durable streams the retained tail so far, so each partial is scrubbed whole.
		const partials = [
			"line 1\n",
			`line 1\n${key}\n`,
			`line 1\n${key}\nline 3\n`,
		];
		for (const partial of partials) {
			const once = scrubSecrets(partial);
			expect(once.text, "no partial shows the key").not.toContain(key);
			const twice = scrubSecrets(once.text);
			expect(twice).toEqual({ text: once.text, kinds: [] });
			expect(
				scrubSecrets(partial),
				"the same input scrubs the same way",
			).toEqual(once);
		}
	});
});
