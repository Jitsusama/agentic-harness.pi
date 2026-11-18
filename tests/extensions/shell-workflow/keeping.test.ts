/**
 * Each bash call keeps its output, status and pid on disk while it runs,
 * through the keeping stub, on a real bash: what pi reads is what it
 * read before, even when its tee is slow to write it, a call that ends
 * in its pi takes its files with it, and one handed on leaves them, its
 * status written whatever the command did on its way out, and all it
 * says once whatever read it has gone.
 */

import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashOperations,
	createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COMMAND_STUB,
	COMMAND_VARIABLE,
	KEEP_VARIABLE,
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

/**
 * A folder whose `tee` waits `seconds` before it starts, as one does on a
 * machine too busy to run it at once.
 */
function slowTee(seconds: number): string {
	const dir = mkdtempSync(join(tmpdir(), "slow-tee-"));
	made.push(dir);
	const tee = execFileSync("sh", ["-c", "command -v tee"], {
		encoding: "utf8",
	}).trim();
	const file = join(dir, "tee");
	writeFileSync(file, `#!/bin/sh\nsleep ${seconds}\nexec ${tee} "$@"\n`);
	chmodSync(file, 0o755);
	return dir;
}

/**
 * Operations that read a call's output until `leave` is called, then close
 * their end of its pipes and return with the call still running, as a
 * pi-spawner that leaves kept commands running does when its pi goes.
 */
function readsUntilItLeaves() {
	let leave = (): void => undefined;
	const left = new Promise<void>((resolve) => {
		leave = resolve;
	});
	const operations: BashOperations = {
		async exec(command, cwd, call) {
			const child = spawn("bash", ["-c", command], {
				cwd,
				env: call.env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			child.stdout.on("data", call.onData);
			child.stderr.on("data", call.onData);
			await left;
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			return { exitCode: null };
		},
	};
	return { operations, leave };
}

/** Run `command` as the spawn hook leaves it, collecting what pi reads. */
async function run(
	ops: ReturnType<typeof keeping>["operations"],
	command: string,
	signal: AbortSignal = new AbortController().signal,
	env: Readonly<Record<string, string>> = {},
	timeout?: number,
) {
	let read = "";
	const result = await ops.exec(COMMAND_STUB, tmpdir(), {
		onData: (data) => {
			read += data.toString();
		},
		signal,
		...(timeout !== undefined ? { timeout } : {}),
		env: {
			...process.env,
			[COMMAND_VARIABLE]: command,
			[CALL_VARIABLE]: "mark-1",
			...env,
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
		await vi.waitFor(() =>
			expect(readdirSync(kept.folder), "its files go just after").toEqual([]),
		);
	});

	it("ends only once its tee has written what it said", async () => {
		const kept = keeping();
		const { read } = await run(
			kept.operations,
			"echo out",
			new AbortController().signal,
			{ PATH: `${slowTee(0.3)}:${process.env.PATH ?? ""}` },
		);
		expect(read, "pi read it before the shell had gone").toBe("out\n");
	});

	it("isn't held by what it left writing to its output", async () => {
		const kept = keeping();
		const started = Date.now();
		const { code, read } = await run(kept.operations, "sleep 5 & echo out");
		expect(code).toBe(0);
		expect(read).toBe("out\n");
		expect(Date.now() - started, "ended well before its child").toBeLessThan(
			3000,
		);
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
		expect(
			existsSync(`${work.keep}.carried`),
			"marked carried, so a host's reaper spares it",
		).toBe(true);
		expect(
			readFileSync(`${work.keep}.carried`, "utf8"),
			"by the call's mark, which all it starts inherits",
		).toBe("mark-1");
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

	it("outlives its time limit here once handed on, the pi that took it up holding it", async () => {
		const kept = keeping();
		const signal = new AbortController().signal;
		const running = run(
			kept.operations,
			"echo started; sleep 0.8; exit 5",
			signal,
			{},
			0.3,
		);
		const carry = kept.carryOf(signal);
		await until(
			"the call to have its pid on disk",
			() => carry?.what() !== undefined,
		);
		const work = carry?.what();
		if (!isCarriedShell(work)) throw new Error(`carried as ${String(work)}`);
		expect(work.deadline, "the deadline goes with it").toBeDefined();
		carry?.handed();
		expect(
			(await running).code,
			"not killed at a limit that's no longer this pi's",
		).toBe(5);
		expect(endOf(work.keep), "its own end is on disk").toBe(5);
	});

	it("times out as pi says while it is still this pi's", async () => {
		const kept = keeping();
		const started = Date.now();
		await expect(
			run(kept.operations, "sleep 5", new AbortController().signal, {}, 0.3),
		).rejects.toThrow("timeout:0.3");
		expect(Date.now() - started, "stopped at its limit").toBeLessThan(3000);
		await vi.waitFor(() =>
			expect(readdirSync(kept.folder), "its files go just after").toEqual([]),
		);
	});

	it("writes all it says once what read it has gone, as a spawner leaving it does", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keeping-"));
		made.push(dir);
		const folder = join(dir, "kept");
		const reader = readsUntilItLeaves();
		const kept = keepsOnDisk(reader.operations, {
			can: () => true,
			folder: () => folder,
		});
		const signal = new AbortController().signal;
		const running = run(
			kept.operations,
			"echo tick-1; sleep 0.3; for i in 2 3 4 5 6; do echo tick-$i; done; exit 7",
			signal,
		);
		const carry = kept.carryOf(signal);
		await until(
			"the call to have its pid on disk",
			() => carry?.what() !== undefined,
		);
		const work = carry?.what();
		if (!isCarriedShell(work)) throw new Error(`carried as ${String(work)}`);
		carry?.handed();
		await until("its first line on disk", () =>
			outputOf(work.keep).startsWith("tick-1\n"),
		);
		reader.leave();
		expect((await running).code, "its reader went before it ended").toBeNull();
		await until("its end on disk", () => endOf(work.keep) !== undefined);
		expect(endOf(work.keep), "its own status, not a broken pipe's").toBe(7);
		expect(
			outputOf(work.keep),
			"every line, those after its reader went too",
		).toBe("tick-1\ntick-2\ntick-3\ntick-4\ntick-5\ntick-6\n");
	});

	// A job is said ended only once its call settles, and a move or a
	// shutdown meeting one neither carriable nor ended would drop it.
	it("is said ended at once, and can't be carried or handed on while its files go", async () => {
		const dir = mkdtempSync(join(tmpdir(), "keeping-"));
		made.push(dir);
		const folder = join(dir, "kept");
		const signal = new AbortController().signal;
		let ended = false;
		const seen: unknown[] = [];
		// Asks after the call each turn of the loop from the moment its shell
		// ends, as a move arriving then would.
		const ask = () => {
			if (!ended) return;
			const carry = kept.carryOf(signal);
			const work = carry?.what();
			if (work !== undefined) {
				seen.push(work);
				carry?.handed();
			}
			setImmediate(ask);
		};
		const kept = keepsOnDisk(
			{
				async exec(_command, _cwd, call) {
					const keep = call.env?.[KEEP_VARIABLE];
					writeFileSync(`${keep}.pid`, String(process.pid));
					writeFileSync(`${keep}.end`, "0");
					ended = true;
					setImmediate(ask);
					return { exitCode: 0 };
				},
			},
			{ can: () => true, folder: () => folder },
		);
		await run(kept.operations, "true", signal);
		expect(
			readdirSync(folder).length,
			"said ended before its files go",
		).toBeGreaterThan(0);
		await vi.waitFor(() =>
			expect(readdirSync(folder), "its files go just after").toEqual([]),
		);
		ended = false;
		expect(seen, "nothing to carry once it ended here").toEqual([]);
	});
});
