/**
 * Each bash call keeps its output, status and pid on disk while it runs,
 * through the keeping stub, on a real bash: what pi reads is what it
 * read before, a call that ends in its pi takes its files with it, and
 * one handed on leaves them, its status written whatever the command did
 * on its way out.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMMAND_STUB,
	COMMAND_VARIABLE,
} from "../../../extensions/shell-workflow/command-line.ts";
import { keepsOnDisk } from "../../../extensions/shell-workflow/keeping.ts";
import { isCarriedShell } from "../../../lib/internal/shell/carried.ts";
import { endOf, outputOf } from "../../../lib/internal/shell/kept.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";
import { until } from "../../support/until.ts";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** Keeping operations over real bash, their files in a folder of their own. */
function keeping() {
	const dir = mkdtempSync(join(tmpdir(), "keeping-"));
	made.push(dir);
	const folder = join(dir, "kept");
	return {
		folder,
		...keepsOnDisk(createLocalBashOperations(), {
			can: () => true,
			folder: () => folder,
		}),
	};
}

/** Run `command` as the spawn hook leaves it, collecting what pi reads. */
async function run(
	ops: ReturnType<typeof keeping>["operations"],
	command: string,
	signal: AbortSignal = new AbortController().signal,
) {
	let read = "";
	const result = await ops.exec(COMMAND_STUB, tmpdir(), {
		onData: (data) => {
			read += data.toString();
		},
		signal,
		env: {
			...process.env,
			[COMMAND_VARIABLE]: command,
			[CALL_VARIABLE]: "mark-1",
		},
	});
	return { code: result.exitCode, read };
}

describe("a kept call", () => {
	it("reads as it did and leaves nothing once it ends in its pi", async () => {
		const kept = keeping();
		const { code, read } = await run(
			kept.operations,
			"echo out; echo err >&2; exit 3",
		);
		expect(code).toBe(3);
		expect(read.split("\n").sort()).toEqual(["", "err", "out"]);
		expect(readdirSync(kept.folder), "its files went with it").toEqual([]);
	});

	it("is not kept where it can't be", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keeping-"));
		made.push(dir);
		const folder = join(dir, "kept");
		const off = keepsOnDisk(createLocalBashOperations(), {
			can: () => false,
			folder: () => folder,
		});
		const signal = new AbortController().signal;
		expect((await run(off.operations, "echo out", signal)).read).toBe("out\n");
		expect(off.carryOf(signal), "nothing to carry it by").toBeUndefined();
	});

	it("leaves its files when handed on, its status written past its own exit trap", async () => {
		const kept = keeping();
		const signal = new AbortController().signal;
		const running = run(
			kept.operations,
			"trap 'echo bye' EXIT; echo started; sleep 0.3; exit 4",
			signal,
		);
		const carry = kept.carryOf(signal);
		await until(
			"the call to have its pid on disk",
			() => carry?.what() !== undefined,
		);
		const work = carry?.what();
		if (!isCarriedShell(work)) throw new Error(`carried as ${String(work)}`);
		expect(work.mark).toBe("mark-1");
		carry?.handed();
		expect((await running).code).toBe(4);
		expect(endOf(work.keep), "its status is on disk").toBe(4);
		expect(outputOf(work.keep)).toBe("started\nbye\n");
		expect(
			Number(readFileSync(`${work.keep}.pid`, "utf8")),
			"its shell's pid is on disk",
		).toBe(work.pid);
		expect(
			carry?.what(),
			"once handed, it isn't carried twice",
		).toBeUndefined();
	});
});
