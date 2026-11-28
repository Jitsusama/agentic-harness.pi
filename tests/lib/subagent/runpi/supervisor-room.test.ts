/**
 * A reviewer asked to run on a room, on the real supervisor with a
 * stand-in for the node's `mycelium run`: what the room streamed is
 * the run, its recorded findings come back as the journal, and a room
 * that said nothing at all fails the run rather than running it here,
 * since its round skipped this machine's bars. On the `cloud` room the
 * stand-in's `place` says which machine each reviewer runs on.
 */

import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	RoomAsk,
	RunPiResult,
} from "../../../../lib/subagent/run-contract.ts";
import { roomPlaced } from "../../../../lib/subagent/runpi/room-place.ts";
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

/**
 * A run asked onto a room whose node is the script at `mycelium`, with
 * a local child that marks each time it ran, then says `local`.
 */
async function roomRun(
	lines: string[],
	more: Parameters<typeof runChild>[2] = {},
	node?: string,
	local: string[] = answered("here"),
	options: { wrapUpReserveMs?: number } = {},
) {
	const stateDir = await tempStateDir();
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

	it("fails, never running here, when no room took it and it said nothing", async () => {
		const { result, here } = await roomRun([
			`process.stderr.write("no machine has a slot");`,
			"process.exit(255);",
		]);

		expect(here, "nothing ran here").toBe(false);
		expect(result.state).toBe("failed");
		expect(result.warnings?.join(" ")).toMatch(
			/No room ran this reviewer \(it ended 255: no machine has a slot\), and it doesn't run here: its round skipped this machine's bars/,
		);
	});

	it("fails, never running here, when the room ended cleanly having said nothing", async () => {
		const { result, here } = await roomRun(["process.exit(0);"]);

		expect(here, "nothing ran here").toBe(false);
		expect(result.state).toBe("failed");
		expect(result.warnings?.join(" ")).toMatch(/it ended 0/);
	});

	it("fails, never running here, when the node's command isn't there to start", async () => {
		const { result, here } = await roomRun([], {}, "/nowhere/mycelium");

		expect(here, "nothing ran here").toBe(false);
		expect(result.state).toBe("failed");
		expect(result.warnings?.join(" ")).toMatch(/No room ran this reviewer/);
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

	it("fails from the start, never running here, when the entry would refuse its words", async () => {
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

		expect(result.state).toBe("failed");
		expect(result.finalAssistantText).not.toBe("here");
		expect(result.warnings?.join(" ")).toMatch(
			/No room could take this reviewer \(it names more than one file to read\), and it doesn't run here/,
		);
	});
});

/** The node's answer placing work on `machine`. */
const placedOn = (machine: string) =>
	JSON.stringify({ Ok: { Placement: { placed: { machine, passed: [] } } } });

/**
 * A node whose `place` says each of `answers` in turn, writing down the
 * words each place was asked with, and whose `run` writes down the
 * machine it was pinned to and answers as a room does.
 */
async function placingNode(stateDir: string, answers: string[]) {
	const places = join(stateDir, "places.log");
	const runs = join(stateDir, "runs.log");
	const mycelium = await script(join(stateDir, "mycelium"), [
		`import { appendFileSync, readFileSync } from "node:fs";`,
		"const words = process.argv.slice(2);",
		`if (words.includes("place")) {`,
		`  appendFileSync(${JSON.stringify(places)}, JSON.stringify(words) + "\\n");`,
		`  const asked = readFileSync(${JSON.stringify(places)}, "utf8").split("\\n").filter(Boolean).length;`,
		`  process.stdout.write(${JSON.stringify(answers)}[asked - 1] + "\\n");`,
		"  process.exit(0);",
		"}",
		`appendFileSync(${JSON.stringify(runs)}, words[words.indexOf("--need") + 1] + "\\n");`,
		...answered("there"),
	]);
	const lines = (path: string) =>
		readFile(path, "utf8").then(
			(text) => text.split("\n").filter(Boolean),
			() => [],
		);
	return {
		mycelium,
		places: async () => (await lines(places)).map((line) => JSON.parse(line)),
		runs: () => lines(runs),
	};
}

/**
 * Reviewers asked one after another on the room `machine` names, of a
 * node standing in as `placingNode` makes it, each with a local child
 * that marks having run here.
 */
async function placedRuns(machine: string, answers: string[], count: number) {
	const stateDir = await tempStateDir();
	const ranHere = join(stateDir, "ran-here");
	const childPath = await script(join(stateDir, "child.mjs"), [
		`import { appendFileSync } from "node:fs";`,
		`appendFileSync(${JSON.stringify(ranHere)}, "here\\n");`,
		...answered("here"),
	]);
	await writeFile(join(stateDir, "brief.md"), "the brief");
	const node = await placingNode(stateDir, answers);
	const room: RoomAsk = {
		place: {
			mycelium: node.mycelium,
			realm: "work",
			machine,
			harnessRoot: "/pkg",
		},
		code: { repo: "agentic-harness.pi", commit: "a".repeat(40) },
	};
	const results: RunPiResult[] = [];
	for (let at = 1; at <= count; at += 1) {
		results.push(
			await runChild(
				childPath,
				stateDir,
			)({
				args: ["--mode", "json", "--no-session", "-p", "@brief.md"],
				cwd: stateDir,
				runId: "run",
				reviewerId: `reviewer-${at}`,
				room,
			}),
		);
	}
	const here = await readFile(ranHere, "utf8").then(
		() => true,
		() => false,
	);
	return {
		results,
		here,
		places: await node.places(),
		runs: await node.runs(),
	};
}

describe("a reviewer asked on the cloud room", () => {
	it("runs pinned to the machine the node placed it on, each reviewer placed apart", async () => {
		const { results, here, runs } = await placedRuns(
			"cloud",
			[placedOn("cloud-1"), placedOn("cloud-2")],
			2,
		);

		for (const result of results) {
			expectRan(result);
			expect(result.finalAssistantText).toBe("there");
		}
		expect(here, "nothing ran here").toBe(false);
		expect(runs).toEqual(["machine=cloud-1", "machine=cloud-2"]);
	});

	it("is placed for a cloud machine lasting its wall clock, never one made for it", async () => {
		const { places } = await placedRuns("cloud", [placedOn("cloud-1")], 1);

		// runChild gives every run a two-minute wall clock.
		expect(places).toEqual([
			["--realm=work", "place", "--need", "cloud", "--lasts", "2m"],
		]);
		expect(places.flat()).not.toContain("--may-cost");
	});

	it("fails, never running here or anywhere, when the node places it on no machine", async () => {
		const refused = JSON.stringify({
			Ok: {
				Placement: {
					refused: {
						misses: [{ machine: "cloud-1", because: [{ full: 40 }] }],
					},
				},
			},
		});
		const { results, here, runs } = await placedRuns("cloud", [refused], 1);

		expect(here, "nothing ran here").toBe(false);
		expect(runs, "nothing ran on a room").toEqual([]);
		expect(results[0]?.state).toBe("failed");
		expect(results[0]?.warnings?.join(" ")).toMatch(
			/No room could take this reviewer \(the node placed it on no machine: no machine takes it: cloud-1 holds the 40 sessions it holds at most\), and it doesn't run here/,
		);
	});

	it("fails, never running here, when the node's place fails", async () => {
		const { results, here, runs } = await placedRuns("cloud", [""], 1);

		expect(here, "nothing ran here").toBe(false);
		expect(runs, "nothing ran on a room").toEqual([]);
		expect(results[0]?.state).toBe("failed");
		expect(results[0]?.warnings?.join(" ")).toMatch(
			/No room could take this reviewer \(the node's place failed: /,
		);
	});

	it("is placed nowhere when the node doesn't answer in time", async () => {
		const stateDir = await tempStateDir();
		const mycelium = await script(join(stateDir, "mycelium"), [
			`setTimeout(() => process.stdout.write(${JSON.stringify(placedOn("late"))}), 5000);`,
		]);
		const place = {
			mycelium,
			realm: "work",
			machine: "cloud",
			harnessRoot: "/pkg",
		};

		expect(await roomPlaced(place, 60_000, stateDir, 1000)).toEqual({
			stays: "the node placed it nowhere within 1 s",
		});
	});
});

describe("a reviewer asked on a named room", () => {
	it("runs on that room with no place asked", async () => {
		const { results, places, runs } = await placedRuns(
			"room-1",
			[placedOn("cloud-1")],
			1,
		);

		for (const result of results) expectRan(result);
		expect(places).toEqual([]);
		expect(runs).toEqual(["machine=room-1"]);
	});
});
