/**
 * A thread started from source takes node's modules through
 * `process.getBuiltinModule`, never `require`.
 *
 * An eval worker takes its process's flags, so in a process started with
 * `--input-type=module`, as the host's own end-to-end runs start the
 * host, its source is a module and `require` isn't defined. The stop's
 * backstop was armed by no thread there until 23 November, and on 24
 * November the stores' checkpoint thread and the hold watch were found
 * the same way: each died at its first line in every end-to-end host,
 * while every live host, started from its file, ran them, so the tests
 * judged a host unlike the one that runs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageFiles } from "./package-files.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** A worker given its program as source. */
const EVAL_WORKER = /new Worker\([^)]*eval:\s*true/s;

/** A builtin reached through require, which a module has no such name for. */
const REQUIRED_BUILTIN = /\brequire\(\s*["']node:[^"']+["']\s*\)/g;

describe("threads started from source", () => {
	it("take node's modules through process.getBuiltinModule, never require", () => {
		const requiring = packageFiles(ROOT)
			.filter((file) => file.endsWith(".ts") && !file.startsWith("tests/"))
			.flatMap((file) => {
				const source = readFileSync(join(ROOT, file), "utf8");
				if (!EVAL_WORKER.test(source)) return [];
				return [...source.matchAll(REQUIRED_BUILTIN)].map(
					(found) => `${file}: ${found[0]}`,
				);
			});
		expect(
			requiring,
			"a program a thread runs from source reaches node's modules through process.getBuiltinModule",
		).toEqual([]);
	});
});
