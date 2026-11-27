/**
 * A reviewer asked to run on a room, on the real supervisor with a
 * stand-in for the node's `mycelium run`: what the room streamed is
 * the run, its recorded findings come back as the journal, and only a
 * room that said nothing at all hands the reviewer back to run here.
 */

import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

/**
 * A run asked onto a room whose node is the script at `mycelium`, with
 * a local child that marks that it ran.
 */
async function roomRun(
	lines: string[],
	more: Parameters<typeof runChild>[2] = {},
	node?: string,
) {
	const stateDir = await tempStateDir();
	const ranHere = join(stateDir, "ran-here");
	const childPath = await script(join(stateDir, "child.mjs"), [
		`import { writeFileSync } from "node:fs";`,
		`writeFileSync(${JSON.stringify(ranHere)}, "");`,
		...answered("here"),
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
	});
	const here = await access(ranHere).then(
		() => true,
		() => false,
	);
	return { result, here, stateDir };
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

	it("starts the room's command outside the tree under review, with no relative PATH folder", async () => {
		const seen = join(await tempStateDir(), "seen.json");
		vi.stubEnv("PATH", `bin:${process.env.PATH ?? ""}`);
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
