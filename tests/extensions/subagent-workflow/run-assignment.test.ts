/** How `buildAssignment` turns a tool's subagent into an engine job. */

import { describe, expect, it } from "vitest";
import { buildAssignment } from "../../../extensions/subagent-workflow/run.ts";

describe("buildAssignment", () => {
	it("defaults isolation to true at the tool boundary", () => {
		// Library default is `false` to serve pr-workflow;
		// the fleet tool defaults to `true` because clean-
		// slate runs are the common case here. Without this
		// inversion the user's local pi setup would leak
		// into every fleet subagent.
		const out = buildAssignment({
			id: "a",
			cwd: "/tmp",
			userPrompt: "do work",
		});
		expect(out.job).toMatchObject({ isolated: true });
	});

	it("honours an explicit isolated=false override", () => {
		const out = buildAssignment({
			id: "a",
			cwd: "/tmp",
			userPrompt: "do work",
			isolated: false,
		});
		expect(out.job).toMatchObject({ isolated: false });
	});

	it("separates spec fields from job fields", () => {
		const out = buildAssignment({
			id: "persona",
			model: "anthropic/claude-haiku-4-7",
			thinkingLevel: "high",
			tools: ["read", "grep"],
			cwd: "/tmp/wt",
			systemPrompt: "You are a security reviewer.",
			userPrompt: "audit auth.go",
		});
		expect(out.spec).toEqual({
			id: "persona",
			model: "anthropic/claude-haiku-4-7",
			thinkingLevel: "high",
			tools: ["read", "grep"],
		});
		expect(out.job.systemPrompt).toBe("You are a security reviewer.");
		expect(out.job.userPrompt).toBe("audit auth.go");
	});

	it("renames the tool's `extraSkills` field through to the engine job", () => {
		// The new public engine API uses `extraSkills` to
		// match its sibling `extraExtensions`. Catch any
		// future drift where the tool boundary forwards an
		// out-of-date `skills` field that the engine would
		// silently drop on the floor (spread-into-typed-
		// object skips excess-property checks).
		const out = buildAssignment({
			id: "with-skills",
			cwd: "/tmp",
			userPrompt: "x",
			extraSkills: ["/abs/skill.md"],
		});
		expect(out.job.extraSkills).toEqual(["/abs/skill.md"]);
	});

	it("forwards per-job timeout overrides into the engine job", () => {
		// Long-running personas (gsperf bench runs, gcloud
		// deploys, soak tests) need to override the
		// supervisor's idle and wall-clock defaults without
		// bumping them globally. The tool boundary takes
		// milliseconds as plain integers and passes them
		// straight through to the engine job.
		const out = buildAssignment({
			id: "long-running",
			cwd: "/tmp",
			userPrompt: "bench",
			timeoutMs: 45 * 60 * 1000,
			idleTimeoutMs: 15 * 60 * 1000,
		});
		expect(out.job.timeoutMs).toBe(45 * 60 * 1000);
		expect(out.job.idleTimeoutMs).toBe(15 * 60 * 1000);
	});

	it("omits timeout fields entirely when the caller doesn't set them", () => {
		// The engine treats `undefined` as "use the runner's
		// configured default". Leaving the keys absent (rather
		// than passing `undefined`) keeps the job payload
		// minimal and round-trips cleanly through JSON.
		const out = buildAssignment({
			id: "default-timeouts",
			cwd: "/tmp",
			userPrompt: "x",
		});
		expect(out.job).not.toHaveProperty("timeoutMs");
		expect(out.job).not.toHaveProperty("idleTimeoutMs");
	});

	it("forwards verify packs with and without companion skills", () => {
		const withSkill = buildAssignment({
			id: "v",
			cwd: "/tmp",
			userPrompt: "x",
			verify: {
				extensionPath: "/abs/v.ts",
				skillPath: "/abs/v.md",
			},
		});
		expect(withSkill.job.verify).toEqual({
			extensionPath: "/abs/v.ts",
			skillPath: "/abs/v.md",
		});
		const withoutSkill = buildAssignment({
			id: "v",
			cwd: "/tmp",
			userPrompt: "x",
			verify: { extensionPath: "/abs/v.ts" },
		});
		expect(withoutSkill.job.verify).toEqual({ extensionPath: "/abs/v.ts" });
	});
});
