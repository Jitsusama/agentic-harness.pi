/**
 * The tree's thread takes none of its host's flags. A thread inherits
 * the flags its process ran with, and some refuse a program file: run
 * with --input-type, as the package's own loading tests run their
 * children, every signing failed, and the last walk stood forever.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const THREAD = join(
	import.meta.dirname,
	"../../../../../lib/internal/quest/discovery/tree-thread.ts",
);

/** Long enough for a child node to start on a busy machine. */
const CHILD_WITHIN_MS = 20_000;

let home: string | undefined;

afterEach(() => {
	if (home !== undefined) rmSync(home, { recursive: true, force: true });
	home = undefined;
});

describe("the tree's thread", () => {
	it("reads a tree in a process run with --input-type", () => {
		home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "thread-flags-"));
		const root = join(home, "quests");
		mkdirSync(root);
		const script = [
			`import { readTreeInThread } from ${JSON.stringify(THREAD)};`,
			`const read = await readTreeInThread(${JSON.stringify(root)}, new Map(), 10_000);`,
			'console.log("listed", read.listings.length);',
		].join("\n");
		const said = execFileSync(
			process.execPath,
			["--input-type=module", "-e", script],
			{ encoding: "utf8", timeout: CHILD_WITHIN_MS, stdio: "pipe" },
		);
		expect(said.trim()).toBe("listed 1");
	});
});
