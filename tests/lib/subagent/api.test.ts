import { describe, expect, it } from "vitest";
import {
	type RunPi,
	type RunPiResult,
	runFleet,
	runSubagent,
	verifyProtocolInstruction,
} from "../../../lib/subagent/subagent";

// The composite `runSubagent` / `runFleet` API sits on top
// of the flat `runReviewer` engine. These tests pin the
// translation surface: how SubagentJob fields map onto pi
// CLI args, how verify packs flow through, how the fleet
// fan-out aggregates results. The deeper engine behaviour
// (verify enforcement, stream parsing, recovery) is
// covered by subagent.test.ts and friends.

interface FakeRunPi {
	readonly runPi: RunPi;
	readonly calls: Array<{
		readonly args: readonly string[];
		readonly cwd: string;
		readonly reviewerId: string;
		readonly timeoutMs: number | undefined;
		readonly idleTimeoutMs: number | undefined;
	}>;
}

function fakeRunPi(result?: Partial<RunPiResult>): FakeRunPi {
	const calls: FakeRunPi["calls"] = [];
	const runPi: RunPi = async ({
		args,
		cwd,
		reviewerId,
		timeoutMs,
		idleTimeoutMs,
	}) => {
		calls.push({
			args,
			cwd,
			reviewerId: reviewerId ?? "",
			timeoutMs,
			idleTimeoutMs,
		});
		return {
			exitCode: 0,
			lines: [],
			finalAssistantText: "{}",
			stderr: "",
			warnings: [],
			...result,
		};
	};
	return { runPi, calls };
}

describe("runSubagent", () => {
	it("translates SubagentJob fields to runReviewer args", async () => {
		const fake = fakeRunPi();
		await runSubagent({
			spec: { id: "fleet-1", model: "anthropic/claude-haiku-4-7" },
			job: {
				userPrompt: "investigate the parser",
				cwd: "/tmp/wt-a",
				systemPrompt: "You are a careful reader.",
				extraSkills: ["/abs/skills/foo/SKILL.md"],
				extraExtensions: ["/abs/extensions/foo.ts"],
			},
			runPi: fake.runPi,
		});
		expect(fake.calls).toHaveLength(1);
		const args = fake.calls[0].args.join(" ");
		expect(args).toContain("--model anthropic/claude-haiku-4-7");
		expect(args).toContain("--system-prompt You are a careful reader.");
		expect(args).toContain("--skill /abs/skills/foo/SKILL.md");
		expect(args).toContain("--extension /abs/extensions/foo.ts");
		expect(args.endsWith("investigate the parser")).toBe(true);
		expect(fake.calls[0].cwd).toBe("/tmp/wt-a");
		expect(fake.calls[0].reviewerId).toBe("fleet-1");
	});

	it("emits isolation flags when job.isolated is true", async () => {
		// Isolated runs need pi to forget everything the
		// user's local setup loads ambiently: skills,
		// AGENTS.md context, auto-discovered extensions.
		const fake = fakeRunPi();
		await runSubagent({
			spec: { id: "iso" },
			job: { userPrompt: "p", cwd: "/tmp/iso", isolated: true },
			runPi: fake.runPi,
		});
		const args = fake.calls[0].args;
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-context-files");
		expect(args).toContain("--no-extensions");
	});

	it("omits isolation flags by default", async () => {
		// pr-workflow reviewers inherit the user's ambient
		// pi setup; isolation must be opt-in.
		const fake = fakeRunPi();
		await runSubagent({
			spec: { id: "ambient" },
			job: { userPrompt: "p", cwd: "/tmp/ambient" },
			runPi: fake.runPi,
		});
		const args = fake.calls[0].args;
		expect(args).not.toContain("--no-skills");
		expect(args).not.toContain("--no-context-files");
		expect(args).not.toContain("--no-extensions");
	});

	it("injects verify-pack paths and demands ok=true", async () => {
		// When a job carries a VerifyPack the engine adds
		// the extension and skill to the subagent and
		// expects verify_output to have been called.
		// Without a successful verify the result warns and
		// blanks the final text.
		const fake = fakeRunPi();
		const result = await runSubagent({
			spec: { id: "v" },
			job: {
				userPrompt: "p",
				cwd: "/tmp/v",
				verify: {
					extensionPath: "/abs/verify.ts",
					skillPath: "/abs/output.skill",
				},
			},
			runPi: fake.runPi,
		});
		const args = fake.calls[0].args.join(" ");
		expect(args).toContain("--extension /abs/verify.ts");
		expect(args).toContain("--skill /abs/output.skill");
		expect(result.verification?.called).toBe(false);
		expect(result.verification?.ok).toBe(false);
	});

	it("forwards per-job timeout overrides to the runner", async () => {
		// The middle forwarding hop (job → reviewer → runner)
		// is the production path: the fleet tool's
		// `buildAssignment` populates `SubagentJob`,
		// `runSubagent` calls `runReviewer`, and
		// `runReviewer` invokes the injected `runPi`. Pin
		// the values so a future refactor that drops the
		// fields silently fails the test instead of
		// silently failing the user's long-running
		// benchmark personas.
		const fake = fakeRunPi();
		await runSubagent({
			spec: { id: "long" },
			job: {
				userPrompt: "bench",
				cwd: "/tmp/long",
				timeoutMs: 45 * 60 * 1000,
				idleTimeoutMs: 15 * 60 * 1000,
			},
			runPi: fake.runPi,
		});
		expect(fake.calls[0].timeoutMs).toBe(45 * 60 * 1000);
		expect(fake.calls[0].idleTimeoutMs).toBe(15 * 60 * 1000);
	});

	it("omits timeout overrides from the runner opts when the job omits them", async () => {
		// `undefined` means "use the runner's configured
		// default". The forwarding chain must propagate
		// absence as absence, not coerce to a value, so the
		// supervisor falls back to the constructor-level
		// defaults a long-lived runner was built with.
		const fake = fakeRunPi();
		await runSubagent({
			spec: { id: "default" },
			job: { userPrompt: "p", cwd: "/tmp/default" },
			runPi: fake.runPi,
		});
		expect(fake.calls[0].timeoutMs).toBeUndefined();
		expect(fake.calls[0].idleTimeoutMs).toBeUndefined();
	});

	it("maps reviewerId onto subagentId in the result", async () => {
		const fake = fakeRunPi();
		const result = await runSubagent({
			spec: { id: "naming" },
			job: { userPrompt: "p", cwd: "/tmp/n" },
			runPi: fake.runPi,
		});
		expect(result.subagentId).toBe("naming");
	});
});

describe("runFleet", () => {
	it("runs every assignment concurrently and aggregates warnings", async () => {
		// One subagent finishing first must not block the
		// others; the result order matches the assignment
		// order so callers can correlate by index.
		const fake = fakeRunPi({
			warnings: ["heads up"],
		});
		const { results, warnings } = await runFleet({
			assignments: [
				{
					spec: { id: "a" },
					job: { userPrompt: "ap", cwd: "/tmp/a" },
				},
				{
					spec: { id: "b" },
					job: { userPrompt: "bp", cwd: "/tmp/b" },
				},
			],
			runPi: fake.runPi,
		});
		expect(results.map((r) => r.subagentId)).toEqual(["a", "b"]);
		expect(warnings).toContain("a: heads up");
		expect(warnings).toContain("b: heads up");
	});

	it("forwards per-assignment onEvent hooks", async () => {
		// The fleet API exposes per-assignment progress
		// observability so the caller can route each
		// subagent's stream to its own widget.
		const seen: string[] = [];
		const events: Record<string, unknown> = {
			type: "message_start",
		};
		const runPi: RunPi = async ({ onEvent, reviewerId }) => {
			onEvent?.(events);
			seen.push(reviewerId ?? "");
			return {
				exitCode: 0,
				lines: [],
				finalAssistantText: "{}",
				stderr: "",
				warnings: [],
			};
		};
		const observed: Array<{ id: string; event: unknown }> = [];
		await runFleet({
			assignments: [
				{
					spec: { id: "alpha" },
					job: { userPrompt: "p", cwd: "/tmp/alpha" },
					onEvent: (e) => observed.push({ id: "alpha", event: e }),
				},
				{
					spec: { id: "beta" },
					job: { userPrompt: "p", cwd: "/tmp/beta" },
					onEvent: (e) => observed.push({ id: "beta", event: e }),
				},
			],
			runPi,
		});
		expect(seen.sort()).toEqual(["alpha", "beta"]);
		expect(observed.map((o) => o.id).sort()).toEqual(["alpha", "beta"]);
	});

	it("contains a rejected assignment as a synthesized warning result", async () => {
		// A spawn-level failure on one assignment (e.g. a
		// missing binary) must not drop the successful
		// siblings on the floor. The fleet returns a placeholder
		// result keyed by spec.id with the rejection captured
		// in `warnings`, matching the contract the JSDoc
		// promises.
		const runPi: RunPi = async ({ reviewerId }) => {
			if (reviewerId === "broken") throw new Error("spawn failed");
			return {
				exitCode: 0,
				lines: [],
				finalAssistantText: "{}",
				stderr: "",
				warnings: [],
			};
		};
		const { results, warnings } = await runFleet({
			assignments: [
				{ spec: { id: "ok" }, job: { userPrompt: "p", cwd: "/tmp/ok" } },
				{ spec: { id: "broken" }, job: { userPrompt: "p", cwd: "/tmp/x" } },
			],
			runPi,
		});
		expect(results.map((r) => r.subagentId)).toEqual(["ok", "broken"]);
		const broken = results[1];
		expect(broken.exitCode).toBe(-1);
		expect(broken.finalAssistantText).toBe("");
		expect(broken.warnings.join(" ")).toMatch(
			/subagent failed to start: spawn failed/,
		);
		expect(warnings.join(" ")).toMatch(/broken: subagent failed to start/);
	});
});

describe("verifyProtocolInstruction", () => {
	it("names the tool and the call/retry/end protocol", () => {
		// Prompt authors drop this into the user prompt
		// when they don't ship a companion skill. The
		// prose has to mention the tool and the three
		// load-bearing states (call, retry-on-false,
		// end-on-true).
		const instruction = verifyProtocolInstruction();
		expect(instruction).toContain("verify_output");
		expect(instruction).toMatch(/ok: false/);
		expect(instruction).toMatch(/ok: true/);
		expect(instruction).toMatch(/end/i);
	});
});
