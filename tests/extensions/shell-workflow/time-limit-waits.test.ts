/**
 * Through the agent's own bash: a time limit on heavy work the machine's
 * queue holds measures the run, not the wait for its turn.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentBash } from "../../../extensions/shell-workflow/agent-bash.ts";
import { queueFolder } from "../../../lib/internal/priority/folder.ts";
import type { Reading } from "../../../lib/internal/priority/room.ts";
import { queueHeavyWork } from "../../../lib/internal/priority/turn.ts";

/** A machine with no room, so the queue gives no turn by itself. */
const FULL: Reading = {
	availableGib: 0,
	memoryPressure: 0,
	vms: 0,
	cpuPressure: 0,
	cores: 16,
	pressure: { cpu: 0, memory: 0, io: 0 },
};

let root: string;
let dir: string;
let undo: (() => void) | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "time-limit-"));
	dir = join(root, "jobs");
	mkdirSync(dir);
	writeFileSync(join(dir, "queue.json"), "{}\n");
	undo = queueHeavyWork({
		folder: queueFolder(dir, {
			isRunning: () => true,
			cgroupOf: () => undefined,
		}),
		session: "session-a",
		pid: process.pid,
		room: () => FULL,
		cgroupFor: () => undefined,
	});
});
afterEach(() => {
	undo?.();
	undo = undefined;
	rmSync(root, { recursive: true, force: true });
});

const textOf = (result: { content: { type: string; text?: string }[] }) =>
	result.content.map((part) => part.text ?? "").join("");

/** Gives the turn to the one job waiting, once it is there. */
async function giveTurnAfter(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
	const job = readdirSync(dir).find((name) => name.endsWith(".job"));
	if (job) writeFileSync(join(dir, `${job.slice(0, -4)}.turn`), "");
}

describe("a time limit on heavy work", () => {
	it("lets work that waited longer than its limit for its turn run", async () => {
		const bash = agentBash(root);
		const ran = bash.execute(
			"t1",
			{ command: ": cargo bench; echo ran", timeout: 1 },
			undefined,
			undefined,
			undefined as never,
		);
		await giveTurnAfter(2_000);
		expect(textOf(await ran)).toContain("ran");
	}, 15_000);

	it("still stops work that runs past its limit once its turn comes", async () => {
		const bash = agentBash(root);
		const ran = bash.execute(
			"t2",
			{ command: ": cargo bench; echo began; sleep 30", timeout: 1 },
			undefined,
			undefined,
			undefined as never,
		);
		await giveTurnAfter(1_500);
		await expect(ran).rejects.toThrow(
			/began\n[\s\S]*Command timed out after 1 seconds/,
		);
	}, 20_000);
});
