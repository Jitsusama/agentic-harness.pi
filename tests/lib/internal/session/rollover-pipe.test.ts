import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROLLOVER = fileURLToPath(
	new URL("../../../../lib/internal/session/rollover.ts", import.meta.url),
);

/**
 * Asks, in a node of its own, for a message from the parent log its
 * first argument names, printing what came back. A node of its own, as
 * a read that blocks would hold up the whole test run for good.
 */
const READ = `
const { messagesOnDisk, ROLLOVER_RECORD } = await import(${JSON.stringify(pathToFileURL(ROLLOVER).href)});
const record = {
	type: "custom",
	id: "r1",
	parentId: null,
	timestamp: "",
	customType: ROLLOVER_RECORD,
	data: { parentSession: process.argv[1], parentLeaf: "m1", carried: {} },
};
console.log(JSON.stringify(messagesOnDisk([record], new Set(["m1"]))));
`;

/** How long the read may take before it counts as waiting on the pipe. */
const READ_LIMIT_MS = 20_000;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rollover-pipe-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("a parent log that is a pipe", () => {
	it("is refused at once when nothing writes to it, rather than waited on", () => {
		const pipe = join(dir, "parent.jsonl");
		execFileSync("mkfifo", [pipe]);

		const ran = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				"--input-type=module",
				"-e",
				READ,
				pipe,
			],
			{ encoding: "utf8", timeout: READ_LIMIT_MS },
		);

		expect(ran.error, "the read should end within its time").toBeUndefined();
		expect(ran.status, ran.stderr).toBe(0);
		expect(JSON.parse(ran.stdout)).toEqual([]);
	}, 30_000);
});
