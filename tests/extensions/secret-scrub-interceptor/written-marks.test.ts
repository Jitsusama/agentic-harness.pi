/**
 * A write or an edit that would put a scrub's mark into a file in place
 * of a credential is refused before it runs, naming why, and one that
 * writes a mark the file already holds, or none, runs as it did.
 *
 * Each mark and credential is made from pieces as the test runs.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import secretScrubInterceptor from "../../../extensions/secret-scrub-interceptor/index.ts";

const mark = (kind: string) => `[secret ${"scrubbed"}: ${kind}]`;
const fresh = () => `z9${randomBytes(19).toString("hex")}`;

describe("a write or an edit holding a scrub's mark", () => {
	type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
	let dir: string;
	let handler: Handler;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "written-marks-"));
		const handlers = new Map<string, Handler>();
		const pi = { on: (name: string, on: Handler) => handlers.set(name, on) };
		secretScrubInterceptor(pi as unknown as ExtensionAPI);
		// A scrub that never listens for calls lets every one run.
		handler = handlers.get("tool_call") ?? (async () => undefined);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const call = (toolName: string, input: Record<string, unknown>) =>
		handler({ type: "tool_call", toolCallId: "t1", toolName, input }, {
			cwd: dir,
		});

	it("is refused as a write over the file whose credential it stands for", async () => {
		const env = mark("environment value");
		writeFileSync(join(dir, ".env"), `TOKEN=${fresh()}\nPORT=80\n`);
		const answer = await call("write", {
			path: ".env",
			content: `TOKEN=${env}\nPORT=8080\n`,
		});
		expect(answer).toMatchObject({ block: true });
		const { reason } = answer as { reason: string };
		expect(reason).toContain(env);
		expect(reason).toContain("credential");
	});

	it("is refused as a write of a new file", async () => {
		const answer = await call("write", {
			path: "copy.env",
			content: `TOKEN=${mark("GitHub token")}\n`,
		});
		expect(answer).toMatchObject({ block: true });
	});

	it("is refused as an edit putting a mark where the file has none", async () => {
		writeFileSync(join(dir, ".env"), `TOKEN=${fresh()}\n`);
		const answer = await call("edit", {
			path: join(dir, ".env"),
			edits: [{ oldText: "TOKEN=", newText: `TOKEN=${mark("TOKEN")}\n#` }],
		});
		expect(answer).toMatchObject({ block: true });
	});

	it("is refused as an edit given in pi's older one-replacement form", async () => {
		writeFileSync(join(dir, "notes.md"), "pool\n");
		const answer = await call("edit", {
			path: "notes.md",
			oldText: "pool",
			newText: `pool ${mark("credential")}`,
		});
		expect(answer).toMatchObject({ block: true });
	});

	it("runs as a write of a mark the file already holds, as a scrub's own test", async () => {
		const aws = mark("AWS access key");
		const test = `const MARK = "${aws}";\n`;
		writeFileSync(join(dir, "scrub.test.ts"), test);
		const answer = await call("write", {
			path: "scrub.test.ts",
			content: `${test}expect(text).toBe(MARK);\n`,
		});
		expect(answer).toBeUndefined();
	});

	it("runs as an edit keeping a mark its old text holds", async () => {
		const env = mark("environment value");
		writeFileSync(join(dir, "README.md"), `The mark reads ${env} here.\n`);
		const answer = await call("edit", {
			path: "README.md",
			edits: [
				{
					oldText: `reads ${env} here`,
					newText: `reads ${env} wherever a secret was`,
				},
			],
		});
		expect(answer).toBeUndefined();
	});

	it("leaves a write with no mark, and any other tool, alone", async () => {
		expect(
			await call("write", { path: "a.txt", content: "nothing secret" }),
		).toBeUndefined();
		expect(
			await call("bash", { command: `echo '${mark("credential")}'` }),
		).toBeUndefined();
	});
});
