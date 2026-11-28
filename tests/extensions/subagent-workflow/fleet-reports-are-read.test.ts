/**
 * A strict parent reads the reports its own fleet's answer names, by
 * pi's file tools and by its commands, and nothing else of pi's state:
 * not another session's run folder, and never to write where the
 * fleet's supervisor reads its instructions.
 *
 * On 28 November two strict sessions' fleets finished 4/4 and named
 * each report under pi's state folder, which the strict profile kept
 * from both their commands and their file tools, so every report went
 * unread and the fleet was run again, its jobs writing into the tree.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "../../../lib/internal/sandbox/sandbox.ts";
import { wrapFor } from "../../../lib/internal/sandbox/sandbox.ts";
import { fileToolRefusal } from "../../../lib/internal/sandbox/sandbox-files.ts";
import { quoted } from "../../../lib/internal/sandbox/sandbox-shell.ts";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.ts";
import { createFleetLedger } from "../../../lib/subagent/fleet.ts";
import type { RunPi } from "../../../lib/subagent/subagent.ts";
import { activateWith } from "../support/review-extension.ts";

vi.mock("../../../lib/subagent/runpi/supervisor.ts", () => ({
	createSupervisorRunPi: (): RunPi => async () => ({
		exitCode: 0,
		finalAssistantText: "done",
		warnings: [],
	}),
}));

let root: string;
let home: string;
let work: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fleet-reports-"));
	home = join(root, "home");
	work = join(root, "work");
	mkdirSync(home);
	mkdirSync(work);
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	// The person's own config is not this test's to read.
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
	// Run unfenced: what is judged is the parent's reach afterwards.
	vi.stubEnv("PI_SANDBOX", undefined);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** Where the subagent tool keeps its fleets' state. */
function state(): string {
	return join(root, "state", "pi", "agentic-harness.pi", "subagent-workflow");
}

/** What the fleet tool hands back, as far as these cases read it. */
interface Answer {
	readonly content: readonly { readonly text: string }[];
	readonly details: {
		readonly runDir?: string;
		readonly results?: readonly { readonly resultPath?: string }[];
	};
}

/** Run one fleet through the tool as `session` would, answered at once. */
async function dispatch(runId: string, session: string): Promise<Answer> {
	const tool = activateWith(
		(await import("../../../extensions/subagent-workflow/index.ts")).default,
	).definitions.get("subagent");
	if (tool === undefined) throw new Error("no subagent tool was registered");
	return (await tool.execute(
		"call-1",
		{ runId, jobs: [{ id: "one", cwd: work, userPrompt: "go" }] },
		undefined,
		undefined,
		{ hasUI: false, sessionManager: { getSessionId: () => session } },
	)) as Answer;
}

/** The report the answer names, written as its supervisor would. */
function reportOf(answer: Answer): string {
	const path = answer.details.results?.[0]?.resultPath;
	if (path === undefined) throw new Error("the answer named no report");
	expect(answer.content[0]?.text, "its text names it too").toContain(path);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ state: "complete" }));
	return path;
}

/** Why the strict profile refuses `session`'s `toolName` at `path`. */
function refusal(
	toolName: string,
	path: string,
	session: string,
): string | undefined {
	return fileToolRefusal(
		{ toolName, input: { path, content: "x" } },
		{
			cwd: work,
			env: { PI_SANDBOX: "strict", PI_SESSION_ID: session },
			home,
		},
	);
}

/** The same, saying so when the tool would run. */
function refused(toolName: string, path: string, session: string): string {
	return refusal(toolName, path, session) ?? `${toolName} ran on ${path}`;
}

/** The shell text that runs a command of `session`'s, strict. */
function strictCommand(session: string): string {
	const sandbox: Sandbox = { kind: "strict", landrun: "landrun" };
	const wrap = wrapFor(
		sandbox,
		{ cwd: work, env: { PI_SANDBOX: "strict", PI_SESSION_ID: session } },
		home,
	);
	return wrap?.("cat report") ?? "";
}

/** A landrun rule as the shell text gives it. */
function rule(flag: string, path: string): string {
	return `${flag} ${quoted(path)}`;
}

describe("a strict parent's own fleet", () => {
	it("reads each report its fleet's answer names with pi's file tools", async () => {
		const answer = await dispatch("fleet-own", "parent-a");
		const report = reportOf(answer);

		expect(
			refusal("read", report, "parent-a"),
			"the read tool refused the parent's own report",
		).toBeUndefined();
		expect(refusal("ls", dirname(report), "parent-a")).toBeUndefined();
	});

	it("reads its fleet's run folder with its commands", async () => {
		const answer = await dispatch("fleet-own", "parent-a");
		const runDir = answer.details.runDir ?? "";
		expect(runDir).toBe(join(state(), "runs", "fleet-own"));
		expect(
			strictCommand("parent-a"),
			"a command reads its run folder",
		).toContain(rule("--ro", runDir));
	});

	it("never writes where the fleet's supervisor reads its instructions", async () => {
		const answer = await dispatch("fleet-own", "parent-a");
		const request = new ReviewerArtifactsStore(state()).paths(
			"fleet-own",
			"one",
		).requestPath;
		mkdirSync(dirname(request), { recursive: true });
		writeFileSync(request, "{}");

		expect(refused("write", request, "parent-a")).toContain("may write only");
		expect(refused("edit", request, "parent-a")).toContain("may write only");
		expect(strictCommand("parent-a")).not.toContain(
			rule("--rw", answer.details.runDir ?? ""),
		);
	});
});

describe("a strict parent and another session's fleet", () => {
	it("never reads another session's run folder", async () => {
		await dispatch("fleet-own", "parent-a");
		const theirs = await dispatch("fleet-theirs", "parent-b");
		const report = reportOf(theirs);

		expect(refused("read", report, "parent-a")).toContain("didn't run");
		expect(refused("ls", join(state(), "runs"), "parent-a")).toContain(
			"didn't run",
		);
		expect(refused("read", join(state(), "fleets"), "parent-a")).toContain(
			"didn't run",
		);
		expect(strictCommand("parent-a")).not.toContain(
			quoted(theirs.details.runDir ?? ""),
		);
	});

	it("may not name its fleet after another session's run to read it", async () => {
		const theirs = await dispatch("fleet-theirs", "parent-b");
		const report = reportOf(theirs);

		const answer = await dispatch("fleet-theirs", "parent-a");

		expect(answer.content[0]?.text).toContain("another session's");
		expect(refused("read", report, "parent-a")).toContain("didn't run");
		const { runs } = await createFleetLedger(
			join(state(), "fleets"),
		).everyFleet();
		expect(runs.map((run) => run.session)).toEqual(["parent-b"]);
	});

	it("may not name its fleet after a run folder nobody's ledger holds", async () => {
		const left = new ReviewerArtifactsStore(state()).rootPaths("fleet-left");
		mkdirSync(left.runDir, { recursive: true });

		const answer = await dispatch("fleet-left", "parent-a");

		expect(answer.content[0]?.text).toContain("another session's");
		expect(strictCommand("parent-a")).not.toContain(quoted(left.runDir));
	});

	it("runs again under a name it used itself", async () => {
		await dispatch("fleet-own", "parent-a");
		const again = await dispatch("fleet-own", "parent-a");

		expect(again.content[0]?.text).toContain("1/1 complete");
	});
});
