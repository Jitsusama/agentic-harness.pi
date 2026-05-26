import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageStateDir } from "../../../lib/internal/package-state-dir";

describe("packageStateDir", () => {
	let originalXdg: string | undefined;

	beforeEach(() => {
		originalXdg = process.env.XDG_STATE_HOME;
	});

	afterEach(() => {
		if (originalXdg === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = originalXdg;
	});

	it("scopes the extension under pi/agentic-harness.pi/", () => {
		// Two pi packages on the same machine must not
		// share state directories. The agentic-harness.pi
		// segment is the boundary that keeps them apart.
		process.env.XDG_STATE_HOME = "/var/state";
		expect(packageStateDir("pr-workflow")).toBe(
			"/var/state/pi/agentic-harness.pi/pr-workflow",
		);
	});

	it("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
		// XDG default behaviour: when the env var is
		// absent, use the per-user state hierarchy under
		// the home directory.
		delete process.env.XDG_STATE_HOME;
		expect(packageStateDir("pr-workflow")).toBe(
			join(
				homedir(),
				".local",
				"state",
				"pi",
				"agentic-harness.pi",
				"pr-workflow",
			),
		);
	});

	it('treats XDG_STATE_HOME="" the same as unset', () => {
		// The XDG Base Directory Specification says: "If
		// $XDG_STATE_HOME is either not set or empty, a
		// default equal to $HOME/.local/state should be
		// used.\" An empty value must NOT yield a
		// cwd-relative path — that would silently write
		// state next to wherever the user happened to be
		// standing.
		process.env.XDG_STATE_HOME = "";
		expect(packageStateDir("pr-workflow")).toBe(
			join(
				homedir(),
				".local",
				"state",
				"pi",
				"agentic-harness.pi",
				"pr-workflow",
			),
		);
	});

	it("isolates one extension from its siblings", () => {
		// Two extensions in the same package get distinct
		// directories; the helper never collapses them.
		process.env.XDG_STATE_HOME = "/var/state";
		const a = packageStateDir("pr-workflow");
		const b = packageStateDir("subagent-workflow");
		expect(a).not.toBe(b);
		expect(a).toMatch(/\/pr-workflow$/);
		expect(b).toMatch(/\/subagent-workflow$/);
	});
});
