/**
 * A command the queue's shell runs under a time limit, whether the
 * machine has GNU's `timeout`, as Linux does, or none, as a Mac
 * (87KI6A [606d1d2c]).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limited } from "../../../../lib/internal/priority/limited.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "limited-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A folder holding only `tools`, linked from where this machine has them. */
function onlyThese(tools: readonly string[]): string {
	const bin = join(root, "bin");
	mkdirSync(bin);
	for (const tool of tools) {
		const found = spawnSync("bash", ["-c", `command -v ${tool}`], {
			encoding: "utf8",
		}).stdout.trim();
		symlinkSync(found, join(bin, tool));
	}
	return bin;
}

/** Runs `text` in bash with `path` as its PATH. */
const run = (text: string, path = process.env.PATH ?? "") =>
	spawnSync("bash", ["-c", text], {
		encoding: "utf8",
		env: { ...process.env, PATH: path },
	});

describe("a limited command", () => {
	it("runs with its words and exit status", () => {
		const ran = run(limited(10, "bash -c 'echo \"$0 $1\"; exit 3' one two"));
		expect({ status: ran.status, out: ran.stdout }).toEqual({
			status: 3,
			out: "one two\n",
		});
	});

	it("is ended once its time is up", () => {
		const started = Date.now();
		const ran = run(limited(1, "sleep 30"));
		expect(ran.status, "it ended as it would have finished").not.toBe(0);
		expect(Date.now() - started, "it ran past its limit").toBeLessThan(10_000);
	});

	it("is ended by perl's alarm where there is no timeout, as on a Mac", () => {
		const started = Date.now();
		const ran = run(
			limited(1, "bash -c 'echo began; exec sleep 30'"),
			onlyThese(["bash", "perl", "sleep"]),
		);
		expect(ran.stdout, "it never began").toBe("began\n");
		expect(ran.status, "it ended as it would have finished").not.toBe(0);
		expect(Date.now() - started, "it ran past its limit").toBeLessThan(10_000);
	});

	it("runs unlimited where the machine has no way to limit it", () => {
		const ran = run(
			limited(10, "bash -c 'echo ran; exit 3'"),
			onlyThese(["bash"]),
		);
		expect({ status: ran.status, out: ran.stdout, err: ran.stderr }).toEqual({
			status: 3,
			out: "ran\n",
			err: "",
		});
	});
});
