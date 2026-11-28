import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queueFolder } from "../../../../lib/internal/priority/folder.ts";
import { PASS_AFTER_MS } from "../../../../lib/internal/priority/queue.ts";
import type { Reading } from "../../../../lib/internal/priority/room.ts";
import {
	queuedCommand,
	queueHeavyWork,
	waitsForTurn,
} from "../../../../lib/internal/priority/turn.ts";
import { offerShellEnvironment } from "../../../../lib/internal/shell/environment.ts";

/** A machine with nothing free, so a job asked waits. */
const FULL: Reading = {
	availableGib: 0,
	memoryPressure: 0,
	vms: 0,
	cpuPressure: 0,
	cores: 16,
	pressure: { cpu: 0, memory: 0, io: 0 },
};

/** The moment every job here is asked at. */
const NOW = Date.parse("2026-11-27T21:30:00Z");

let root: string;
let dir: string;
let undo: (() => void) | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "turn-late-"));
	dir = join(root, "jobs");
	mkdirSync(dir);
	writeFileSync(join(dir, "queue.json"), "{}\n");
	undo = queueHeavyWork({
		folder: queueFolder(dir, {
			isRunning: () => true,
			cgroupOf: () => undefined,
		}),
		session: "session-a",
		room: () => FULL,
		cgroupFor: () => undefined,
		now: () => NOW,
	});
});
afterEach(() => {
	undo?.();
	undo = undefined;
	rmSync(root, { recursive: true, force: true });
});

/** Every job asked for, as it was written down, by what it runs. */
const dueAsked = () =>
	Object.fromEntries(
		readdirSync(dir)
			.filter((name) => name.endsWith(".job"))
			.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
			.map((job) => [job.what, job.dueToStart]),
	);

/** Resolves once `file` exists, looked for every 50 ms. */
async function appears(file: string): Promise<void> {
	while (!existsSync(file)) {
		// A poll, not a fixed wait: the shell writes it as it starts.
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** What a late job's waiter is told, as a keep writes it. */
const LATE =
	"Due to start by 21:40 and still waiting for its turn in the machine queue: 2nd in line, held by memory.";

/**
 * Runs `command` in bash, its output and errors gathered as one, with a
 * promise that settles once its output holds `seen`.
 */
function run(command: string, seen: string) {
	const shell = spawn("bash", ["-c", command]);
	let out = "";
	let saw: () => void = () => undefined;
	const shown = new Promise<void>((resolve) => {
		saw = resolve;
	});
	const gather = (data: Buffer) => {
		out += data;
		if (out.includes(seen)) saw();
	};
	shell.stdout.on("data", gather);
	shell.stderr.on("data", gather);
	const ended = new Promise<{ out: string; code: number | null }>((resolve) =>
		shell.on("exit", (code) => resolve({ out, code })),
	);
	return { shown, ended };
}

describe("a late job's waiting shell", () => {
	// It spans about four of the wait's one-second polls, which vitest's
	// default of 5 s leaves no room for on a loaded machine.
	it("says the queue's line once, however long it goes on waiting", {
		timeout: 30_000,
	}, async () => {
		writeFileSync(join(dir, "j1.job"), "{}\n");
		// Empty as the wait starts, so only a wait that reads it each poll
		// sees the line a keep writes later.
		writeFileSync(join(dir, "j1.late"), "");
		const { shown, ended } = run(
			`${waitsForTurn(dir, 60)?.("j1")}\necho "ran \${__told-}\${__late-}"`,
			LATE,
		);
		await appears(join(dir, "j1.pid"));
		// Past the wait's first poll, which finds the line still empty.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		writeFileSync(join(dir, "j1.late"), `${LATE}\n`);
		await shown;
		// The wait polls each second, so this spans two more polls, each of
		// which would say the line again were it not said once.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		writeFileSync(join(dir, "j1.turn"), "");
		expect(await ended).toEqual({ out: `${LATE}\nran \n`, code: 0 });
	});
});

describe("heavy work saying when it is due to start", () => {
	it("asks with the time its command or its shell gives, or its kind's bound", () => {
		queuedCommand("PI_DUE_TO_START=+10 cargo build", root);
		queuedCommand(`PI_DUE_TO_START=${NOW / 1000 + 60} cargo test`, root);
		queuedCommand("cargo clippy", root);
		offerShellEnvironment("due-under-test", () => ({
			PI_DUE_TO_START: "+3",
		}));
		try {
			queuedCommand("cargo doc", root);
		} finally {
			offerShellEnvironment("due-under-test", undefined);
		}
		expect(dueAsked()).toEqual({
			"cargo build": NOW + 10 * 60_000,
			"cargo test": NOW + 60_000,
			"cargo clippy": NOW + PASS_AFTER_MS,
			"cargo doc": NOW + 3 * 60_000,
		});
	});
});
