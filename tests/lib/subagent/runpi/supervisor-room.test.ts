/**
 * A reviewer asked to run on a room, on the real supervisor with a
 * stand-in for the node's `mycelium run`: what the room streamed is
 * the run, its recorded findings come back as the journal, and only a
 * room that said nothing at all hands the reviewer back to run here.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CPU_PRESSURE_FILE,
	IO_PRESSURE_FILE,
	IO_SLICES,
	MEMINFO_FILE,
	MEMORY_PRESSURE_FILE,
	sliceIoPressureFile,
} from "../../../../lib/core/review/ask/machine-room.ts";
import type { RoomAsk } from "../../../../lib/subagent/run-contract.ts";
import {
	expectRan,
	runChild,
	TEST_TIMEOUT_MS,
	tempStateDir,
} from "./supervised.ts";

// Slack for spawning, not a work budget: TEST_TIMEOUT_MS says why.
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

/** A line of pi's stream, as a child script writes it. */
const said = (event: Record<string, unknown>) =>
	`process.stdout.write(${JSON.stringify(`${JSON.stringify(event)}\n`)});`;

/** How pi ends a run with an answer. */
const answered = (text: string) => [
	said({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }] },
	}),
	said({ type: "agent_end", messages: [] }),
];

/** Writes an executable node script, as the node's command would be. */
async function script(path: string, lines: string[]): Promise<string> {
	await writeFile(path, [`#!${process.execPath}`, ...lines].join("\n"));
	await chmod(path, 0o755);
	return path;
}

/** A pressure file whose avg60 is `memory` on both lines. */
const pressure = (avg60: number) =>
	["some", "full"]
		.map((kind) => `${kind} avg10=0.00 avg60=${avg60} avg300=0.00 total=0`)
		.join("\n");

/**
 * Lays this machine's readings out under `root`, as a fallback reads
 * them: quiet on every one, or with memory full avg60 at `memory`.
 */
async function machineAt(root: string, memory = 0): Promise<void> {
	const files: [string, string][] = [
		[MEMORY_PRESSURE_FILE, pressure(memory)],
		[CPU_PRESSURE_FILE, pressure(0)],
		[IO_PRESSURE_FILE, pressure(0)],
		[MEMINFO_FILE, "MemTotal: 67108864 kB\nMemAvailable: 50331648 kB\n"],
		...IO_SLICES.map((slice): [string, string] => [
			sliceIoPressureFile(slice),
			pressure(0),
		]),
	];
	for (const [file, text] of files) {
		await mkdir(dirname(join(root, file)), { recursive: true });
		await writeFile(join(root, file), text);
	}
}

/**
 * A run asked onto a room whose node is the script at `mycelium`, with
 * a local child that marks each time it ran, then says `local`. This
 * machine reads as quiet unless `more.here` says where else to read.
 */
async function roomRun(
	lines: string[],
	more: Parameters<typeof runChild>[2] = {},
	node?: string,
	local: string[] = answered("here"),
	options: { wrapUpReserveMs?: number } = {},
) {
	const stateDir = await tempStateDir();
	const quiet = join(stateDir, "machine");
	await machineAt(quiet);
	more = { here: { root: quiet }, ...more };
	const ranHere = join(stateDir, "ran-here");
	const childPath = await script(join(stateDir, "child.mjs"), [
		`import { appendFileSync } from "node:fs";`,
		`appendFileSync(${JSON.stringify(ranHere)}, \`\${Date.now()}\\n\`);`,
		...local,
	]);
	const mycelium = node ?? (await script(join(stateDir, "mycelium"), lines));
	await writeFile(join(stateDir, "brief.md"), "the brief");
	const room: RoomAsk = {
		place: { mycelium, realm: "work", machine: "room-1", harnessRoot: "/pkg" },
		code: { repo: "agentic-harness.pi", commit: "a".repeat(40) },
	};
	const result = await runChild(
		childPath,
		stateDir,
		more,
	)({
		args: ["--mode", "json", "--no-session", "-p", "@brief.md"],
		cwd: stateDir,
		runId: "run",
		reviewerId: "roomed",
		room,
		...options,
	});
	const starts = await readFile(ranHere, "utf8").then(
		(text) => text.split("\n").filter(Boolean).map(Number),
		() => [],
	);
	return { result, here: starts.length > 0, starts, stateDir };
}

describe("a reviewer asked to run on a room", () => {
	it("is the room's run, its recorded findings kept here as its journal", async () => {
		const { result, here } = await roomRun([
			said({
				type: "tool_execution_start",
				toolCallId: "1",
				toolName: "record_finding",
				args: { finding: { subject: "found on the room" } },
			}),
			said({
				type: "tool_execution_end",
				toolCallId: "1",
				toolName: "record_finding",
				isError: false,
			}),
			...answered("there"),
		]);

		expectRan(result);
		expect(here, "nothing ran here").toBe(false);
		expect(result.finalAssistantText).toBe("there");
		expect(result.journal).toEqual([{ subject: "found on the room" }]);
	});

	it("starts the room's command outside the tree under review, with none of the reviewer's PATH", async () => {
		const planted = await tempStateDir();
		const seen = join(planted, "seen.json");
		// A relative folder, and an absolute one a fenced command could write.
		vi.stubEnv("PATH", `bin:${planted}:${process.env.PATH ?? ""}`);
		let tree = "";
		try {
			const { result, stateDir } = await roomRun([
				`import { writeFileSync } from "node:fs";`,
				`writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ cwd: process.cwd(), path: process.env.PATH }));`,
				...answered("there"),
			]);
			expectRan(result);
			tree = stateDir;
		} finally {
			vi.unstubAllEnvs();
		}
		const { cwd, path } = JSON.parse(await readFile(seen, "utf8"));
		expect(cwd).not.toBe(tree);
		expect(path.split(":")).not.toContain("bin");
		expect(path.split(":")).not.toContain(planted);
	});

	it("gives the room's command only what the node's command reads, never the reviewer's keys", async () => {
		const seen = join(await tempStateDir(), "env.json");
		vi.stubEnv("A_GATEWAY_TOKEN", "not for the room");
		vi.stubEnv("MYCELIUM_REALM", "work");
		try {
			const { result } = await roomRun([
				`import { writeFileSync } from "node:fs";`,
				`writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));`,
				...answered("there"),
			]);
			expectRan(result);
		} finally {
			vi.unstubAllEnvs();
		}
		const env = JSON.parse(await readFile(seen, "utf8"));
		expect(env.A_GATEWAY_TOKEN).toBeUndefined();
		expect(env.MYCELIUM_REALM).toBe("work");
		expect(env.HOME).toBe(process.env.HOME);
	});

	it("runs here when no room took it and it said nothing", async () => {
		const { result, here } = await roomRun([
			`process.stderr.write("no machine has a slot");`,
			"process.exit(255);",
		]);

		expectRan(result);
		expect(here, "it ran here").toBe(true);
		expect(result.finalAssistantText).toBe("here");
		expect(result.warnings?.join(" ")).toMatch(
			/No room ran this reviewer \(it ended 255: no machine has a slot\)/,
		);
	});

	it("waits for this machine's bars before it runs here", async () => {
		const root = join(await tempStateDir(), "machine");
		await machineAt(root, 50);
		// The room says no at once; this machine has room a second on.
		const quietens = setTimeout(() => void machineAt(root), 1000);
		const began = Date.now();
		const { result, starts } = await roomRun(["process.exit(255);"], {
			here: { root, looksAgainMs: 100 },
		}).finally(() => clearTimeout(quietens));

		expectRan(result);
		expect(starts, "it ran here once").toHaveLength(1);
		expect(
			(starts[0] ?? 0) - began,
			"it started here only once memory had room",
		).toBeGreaterThanOrEqual(1000);
		expect(result.warnings?.join(" ")).toMatch(
			/waited \d+ s for room here first, since memory full avg60 was 50/,
		);
	});

	it("starts nothing here when its wall clock ends while this machine is short", async () => {
		const root = join(await tempStateDir(), "machine");
		await machineAt(root, 50);
		const { result, starts } = await roomRun(["process.exit(255);"], {
			timeoutMs: 3000,
			here: { root, looksAgainMs: 100 },
		});

		expect(starts, "nothing ran here").toHaveLength(0);
		expect(result.state).toBe("timeout");
	});

	it("runs here when the room ended cleanly having said nothing", async () => {
		const { result, here } = await roomRun(["process.exit(0);"]);

		expectRan(result);
		expect(here, "it ran here").toBe(true);
		expect(result.warnings?.join(" ")).toMatch(/it ended 0/);
	});

	it("runs here when the node's command isn't there to start", async () => {
		const { result, here } = await roomRun([], {}, "/nowhere/mycelium");

		expectRan(result);
		expect(here, "it ran here").toBe(true);
		expect(result.warnings?.join(" ")).toMatch(/No room ran this reviewer/);
	});

	it("stops a reviewer run here by the wall clock counted from the run's start, not the fallback's", async () => {
		// The room is slow to say no; the reviewer here then never ends.
		// Margins of three seconds each side, for node's starts under load.
		const roomSaysNo = 3000;
		const timeoutMs = 9000;
		const { result, starts } = await roomRun(
			[`setTimeout(() => process.exit(255), ${roomSaysNo});`],
			{ timeoutMs },
			undefined,
			["setInterval(() => {}, 1000);"],
		);
		const ended = Date.now();

		expect(result.state).toBe("timeout");
		expect(starts).toHaveLength(1);
		// From its start here, a clock restarted at the fallback would give
		// it the whole of timeoutMs, past the parent's backstop.
		expect(ended - (starts[0] ?? 0)).toBeLessThan(timeoutMs - 3000);
	});

	it("starts nothing here once the soft deadline has passed while the room said no", async () => {
		// Its soft deadline at 6 s, the room's no at 7 s, the wall at 10 s.
		const { result, starts } = await roomRun(
			["setTimeout(() => process.exit(255), 7000);"],
			{ timeoutMs: 10_000 },
			undefined,
			answered("here"),
			{ wrapUpReserveMs: 4000 },
		);

		expect(starts, "nothing ran here").toHaveLength(0);
		expect(result.state).toBe("soft-deadline");
	});

	it("ends idle when our clock stops a silent room, and never runs here after", async () => {
		const { result, here } = await roomRun(["setInterval(() => {}, 1000);"], {
			idleTimeoutMs: 1500,
		});

		expect(here, "nothing ran here").toBe(false);
		expect(result.state).toBe("idle-timeout");
	});

	it("is reported as it ended once the room said anything, never run twice", async () => {
		const { result, here } = await roomRun([
			said({ type: "message_start" }),
			"process.exit(1);",
		]);

		expect(here, "nothing ran here").toBe(false);
		expect(result.exitCode).not.toBe(0);
	});

	it("runs here from the start when the entry would refuse its words", async () => {
		const stateDir = await tempStateDir();
		const childPath = await script(
			join(stateDir, "child.mjs"),
			answered("here"),
		);

		const result = await runChild(
			childPath,
			stateDir,
		)({
			args: ["--mode", "json", "-p", "@one.md", "@two.md"],
			cwd: stateDir,
			runId: "run",
			reviewerId: "stays",
			room: {
				place: {
					mycelium: join(stateDir, "absent"),
					realm: "work",
					machine: "room-1",
					harnessRoot: "/pkg",
				},
				code: { repo: "agentic-harness.pi", commit: "a".repeat(40) },
			},
		});

		expectRan(result);
		expect(result.finalAssistantText).toBe("here");
		expect(result.warnings?.join(" ")).toMatch(
			/ran here, not on a room: it names more than one file to read/,
		);
	});
});
