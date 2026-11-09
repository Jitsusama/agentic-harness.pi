import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import commitGuardian from "../../../extensions/commit-guardian/index.ts";
import guardPolicyWorkflow from "../../../extensions/guard-policy-workflow/index.ts";
import verificationWorkflow from "../../../extensions/verification-workflow/index.ts";
import {
	type LspBackend,
	registerLspBackend,
} from "../../../lib/core/lsp/index.ts";
import {
	type Host,
	installHost,
	NoSessionInHost,
	releaseSession,
	withSession,
} from "../../../lib/core/session/index.ts";
import { forgetRedirects, refusalUnder } from "../../../lib/guardian/apply.ts";
import {
	guardMode,
	restoreSessionModes,
	sessionModes,
	setConfiguredModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import {
	GUARD_REPORT_ENTRY,
	reportGuard,
	setGuardReportSink,
} from "../../../lib/guardian/report.ts";
import { list, record } from "../../../lib/internal/guardian/registry.ts";
import {
	currentVerificationFailure,
	provideVerificationCheck,
} from "../../../lib/internal/verification/signal.ts";
import { plainTheme } from "../../lib/ui/fake-theme.ts";
import { type FakePi, fakePi } from "../../support/fake-pi.ts";

let root: string;
let removeHost: () => void;

function context(id: string): ExtensionCommandContext {
	return {
		cwd: join(root, id),
		hasUI: false,
		sessionManager: {
			getSessionId: () => id,
			getBranch: () => [],
			getEntries: () => [],
		},
		ui: { notify: vi.fn(), setStatus: vi.fn(), theme: plainTheme() },
	} as unknown as ExtensionCommandContext;
}

async function dispatch(
	pi: FakePi,
	name: string,
	id: string,
	event: unknown = {},
): Promise<unknown[]> {
	return withSession(id, async () => {
		const results = [];
		for (const handler of pi.recorded.handlers.get(name) ?? [])
			results.push(await handler(event, context(id)));
		return results;
	});
}

function start() {
	const pi = fakePi({
		registerEntryRenderer() {},
		registerMessageRenderer() {},
	});
	// Factories run before any conversation is ambient, as a host may load them.
	guardPolicyWorkflow(pi);
	verificationWorkflow(pi);
	commitGuardian(pi);
	return pi;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hosted-guards-"));
	for (const id of ["a", "b"]) mkdirSync(join(root, id));
	const host: Host = {
		kind: "pi-durable",
		key: "guards-test",
		owner: { pid: 1, startedAt: 1 },
		holds: () => "idle",
		env: () => {
			throw new Error("This test never asks for environment");
		},
		hints: () => ({}),
		close() {},
		stamp() {},
	};
	removeHost = installHost(host);
	setConfiguredModes({});
});

afterEach(() => {
	for (const id of ["a", "b"]) releaseSession(id);
	removeHost();
	setConfiguredModes({});
	restoreSessionModes({});
	setGuardReportSink(undefined);
	provideVerificationCheck(undefined);
	forgetRedirects();
	rmSync(root, { recursive: true, force: true });
});

describe("guards in two conversations sharing a host", () => {
	it("keeps command overrides and saved modes in their conversation", async () => {
		const a = start();
		const b = start();
		await dispatch(a, "session_start", "a");
		await dispatch(b, "session_start", "b");
		const command = a.recorded.commands.get("guards");
		if (!command) throw new Error("guards command missing");
		// Explicit context wins even when another conversation is ambient.
		await withSession("b", () => command.handler("all off", context("a")));
		expect(guardMode("commit-verification", "a")).toBe("off");
		expect(guardMode("commit-verification", "b")).toBe("redirect");
		expect(sessionModes("b")).toEqual({});
		expect(a.recorded.entries).toContainEqual({
			customType: "guard-modes",
			data: { modes: { all: "off" } },
		});
		expect(b.recorded.entries).toEqual([]);
		await command.handler("reset", context("a"));
		expect(sessionModes("a")).toEqual({});
	});

	it("never treats A's redirect as B's override and keeps B's report sink after A ends", async () => {
		const a = start();
		const b = start();
		await dispatch(a, "session_start", "a");
		await dispatch(b, "session_start", "b");
		for (const id of ["a", "b"]) setSessionMode("test", "redirect", id);
		const refused = () =>
			refusalUnder(
				"test",
				{ block: true, reason: "Not right" },
				"Test",
				"same call",
			);
		expect(withSession("a", refused)).toMatchObject({ block: true });
		expect(withSession("b", refused)).toMatchObject({ block: true });
		expect(b.recorded.entries).toEqual([]);
		expect(withSession("b", refused)).toBeUndefined();
		expect(b.recorded.entries).toContainEqual({
			customType: GUARD_REPORT_ENTRY,
			data: {
				guard: "test",
				kind: "overridden",
				title: "Test",
				body: "Not right",
			},
		});
		expect(a.recorded.entries).toEqual([]);
		await dispatch(a, "session_shutdown", "a");
		withSession("b", () =>
			reportGuard({ guard: "test", kind: "fixed", title: "Still B" }),
		);
		expect(b.recorded.entries.at(-1)?.data).toMatchObject({ title: "Still B" });
		withSession("a", () =>
			reportGuard({ guard: "test", kind: "fixed", title: "Closed" }),
		);
		expect(a.recorded.entries).toEqual([]);
	});

	it("shows each conversation's last guard outcome, not its sibling's", () => {
		withSession("a", () => record("test", { kind: "blocked", reason: "A" }));
		withSession("b", () => record("test", { kind: "allowed" }));
		expect(
			list("a").find((entry) => entry.name === "test")?.lastOutcome,
		).toEqual({ kind: "blocked", reason: "A" });
		expect(
			list("b").find((entry) => entry.name === "test")?.lastOutcome,
		).toEqual({ kind: "allowed" });
	});

	it("keeps B's commit-time check after A shuts down and resolves B's relative message file", async () => {
		const a = start();
		const b = start();
		await dispatch(a, "session_start", "a");
		await dispatch(b, "session_start", "b");
		const backend: LspBackend = {
			name: "test",
			diagnostics: async (path) => [
				{
					path,
					severity: "error",
					message: "Broken B",
					range: {
						start: { line: 1, character: 0 },
						end: { line: 1, character: 1 },
					},
				},
			],
			definition: async () => [],
			references: async () => [],
			hover: async () => null,
			documentSymbols: async () => [],
			workspaceSymbols: async () => [],
			rename: async () => ({ changes: [] }),
			codeActions: async () => [],
			dispose: async () => {},
		};
		registerLspBackend(
			{
				name: "test",
				priority: 1,
				isAvailable: () => true,
				backend,
			},
			context("b"),
		);
		const file = join(root, "b", "broken.ts");
		writeFileSync(file, "broken");
		await dispatch(b, "tool_result", "b", {
			toolName: "edit",
			input: { path: file },
			isError: false,
		});
		await dispatch(b, "turn_end", "b", {
			message: { stopReason: "stop" },
			toolResults: [],
		});
		expect(b.recorded.sent).toHaveLength(1);
		expect(a.recorded.sent).toHaveLength(0);
		// A's ambient identity cannot select its backend for B's check.
		expect(
			await withSession("a", () =>
				currentVerificationFailure({ dir: join(root, "b") }, context("b")),
			),
		).toMatchObject({ problems: [expect.stringContaining("Broken B")] });
		await dispatch(a, "session_shutdown", "a");
		expect(
			await withSession("a", () => currentVerificationFailure({})),
		).toBeUndefined();
		writeFileSync(
			join(root, "b", "message.txt"),
			"fix: b\n\nBecause b is broken.\n",
		);
		const results = await dispatch(b, "tool_call", "b", {
			toolName: "bash",
			input: { command: "git commit -F message.txt" },
		});
		expect(results).toContainEqual(
			expect.objectContaining({
				block: true,
				reason: expect.stringContaining("Broken B"),
			}),
		);
	});

	it("reads a commit file from B's git -C directory, not the host or A", async () => {
		const a = start();
		const b = start();
		await dispatch(a, "session_start", "a");
		await dispatch(b, "session_start", "b");
		mkdirSync(join(root, "b", "nested"));
		writeFileSync(join(root, "a", "message.txt"), "fix: a");
		writeFileSync(join(root, "b", "message.txt"), "fix: wrong");
		writeFileSync(join(root, "b", "nested", "message.txt"), "fix: nested");
		const results = await dispatch(b, "tool_call", "b", {
			toolName: "bash",
			input: { command: "git -C nested commit -F message.txt" },
		});
		expect(results).toEqual([undefined]);
		expect(b.recorded.entries).toContainEqual(
			expect.objectContaining({
				customType: GUARD_REPORT_ENTRY,
				data: expect.objectContaining({
					guard: "commit",
					body: expect.stringContaining("fix: nested"),
				}),
			}),
		);
		expect(a.recorded.entries).toEqual([]);
	});

	it("refuses unkeyed hosted guard and verification calls", async () => {
		expect(() => guardMode("commit")).toThrow(NoSessionInHost);
		expect(() =>
			reportGuard({ guard: "test", kind: "shown", title: "Unknown" }),
		).toThrow(NoSessionInHost);
		await expect(currentVerificationFailure({})).rejects.toThrow(
			NoSessionInHost,
		);
	});
});
