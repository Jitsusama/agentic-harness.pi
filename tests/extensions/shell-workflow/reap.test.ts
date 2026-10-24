/**
 * A stopped command takes with it what left the shell's process group.
 *
 * pi stops a command by killing its shell's process group, and GNU
 * `timeout` puts itself in a group of its own, as `setsid` and some
 * build clients do. X7FXPL stopped `timeout 7200 nix-store --realise …`
 * twice on 24 October; each time the tool said the group was killed,
 * and the client ran on until its VM test had finished.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	CALL_VARIABLE,
	reap,
	reapsWhatItLeft,
} from "../../../extensions/shell-workflow/reap.ts";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A /proc holding these processes' environments. */
function procWith(environments: Record<string, string[]>): string {
	const root = mkdtempSync(join(tmpdir(), "reap-proc-"));
	made.push(root);
	for (const [pid, env] of Object.entries(environments)) {
		mkdirSync(join(root, pid));
		writeFileSync(join(root, pid, "environ"), `${env.join("\0")}\0`);
	}
	mkdirSync(join(root, "self"));
	return root;
}

describe("reaping a call", () => {
	it("kills every process carrying the call's mark, and nothing else", () => {
		const procRoot = procWith({
			"101": ["HOME=/h", `${CALL_VARIABLE}=one`],
			"102": [`${CALL_VARIABLE}=two`],
			"103": ["HOME=/h"],
			"104": [`${CALL_VARIABLE}=one`],
		});
		const killed: number[] = [];

		reap("one", { procRoot, self: 104, kill: (pid) => killed.push(pid) });

		expect(killed).toEqual([101]);
	});

	it("does nothing where there is no /proc", () => {
		const killed: number[] = [];

		reap("one", {
			procRoot: join(tmpdir(), "no-such-proc-here"),
			kill: (pid) => killed.push(pid),
		});

		expect(killed).toEqual([]);
	});
});

/** Whether a process with this word in its command line is running. */
function running(word: string): boolean {
	try {
		return (
			execFileSync("pgrep", ["-f", word], { encoding: "utf-8" }).trim() !== ""
		);
	} catch {
		return false;
	}
}

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const bash = reapsWhatItLeft(createLocalBashOperations());

/**
 * A command as the agent's shell runs one. A lone simple command is
 * exec'd by bash, so `timeout` would become the shell and lead its
 * group; the agent's always follow the queue's placement line, so bash
 * forks for them, as the second statement here makes it.
 */
const asTheAgentRunsIt = (word: string) =>
	`timeout 900 sleep ${word} > /dev/null; echo ended`;
const linux = process.platform === "linux";

// Real processes, so room for a loaded machine.
describe.skipIf(!linux)(
	"a command through the agent's shell",
	{ timeout: 30_000 },
	() => {
		it("is stopped whole, a timeout's own group included", async () => {
			const word = `${600 + Math.floor(Math.random() * 1000)}.4242`;
			const stop = new AbortController();

			const done = bash
				.exec(asTheAgentRunsIt(word), process.cwd(), {
					onData: () => {},
					signal: stop.signal,
					env: { ...process.env },
				})
				.catch((error: unknown) => error);
			await until(() => running(`sleep ${word}`));
			stop.abort();
			await done;

			await until(() => !running(`sleep ${word}`));
		});

		it("is stopped whole when pi's time limit ends it", async () => {
			const word = `${600 + Math.floor(Math.random() * 1000)}.4343`;

			const error = await bash
				.exec(asTheAgentRunsIt(word), process.cwd(), {
					onData: () => {},
					timeout: 1,
					env: { ...process.env },
				})
				.catch((caught: unknown) => caught);

			expect(String(error)).toMatch(/timeout:1/);
			await until(() => !running(`sleep ${word}`));
		});

		it("leaves what it set going on purpose once it ends by itself", async () => {
			const word = `${600 + Math.floor(Math.random() * 1000)}.4444`;
			try {
				await bash.exec(
					`setsid sleep ${word} > /dev/null 2>&1 < /dev/null &`,
					process.cwd(),
					{ onData: () => {}, env: { ...process.env } },
				);
				await until(() => running(`sleep ${word}`));
				await new Promise((resolve) => setTimeout(resolve, 200));

				expect(running(`sleep ${word}`)).toBe(true);
			} finally {
				execFileSync("pkill", ["-f", `sleep ${word}`]);
			}
		});
	},
);
