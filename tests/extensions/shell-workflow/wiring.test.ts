/**
 * The registered `bash` is pi's bash built with the person's settings:
 * a command prefix in settings.json still applies, and the agent's
 * commands still get no editor to wait on.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import shellWorkflow from "../../../extensions/shell-workflow/index.ts";

interface Tool {
	name: string;
	parameters: { properties: Record<string, unknown> };
	execute: (
		id: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: { type: string; text?: string }[] }>;
}

let agentDir: string;
let saved: string | undefined;
let tool: Tool | undefined;
let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;

beforeEach(() => {
	saved = process.env.PI_CODING_AGENT_DIR;
	agentDir = mkdtempSync(join(tmpdir(), "shell-workflow-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ shellCommandPrefix: "export WIRED=yes" }),
	);
	const pi = {
		events: createEventBus(),
		on: (event: string, handler: typeof sessionStart) => {
			if (event === "session_start") sessionStart = handler;
		},
		registerTool: (definition: Tool) => {
			tool = definition;
		},
	};
	shellWorkflow(pi as unknown as ExtensionAPI);
});

afterEach(() => {
	if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved;
	rmSync(agentDir, { recursive: true, force: true });
});

const ctx = () => ({
	cwd: agentDir,
	isProjectTrusted: () => false,
	// pi's bash names the session to the command it runs.
	sessionManager: {
		getSessionId: () => "session-1",
		getSessionFile: () => undefined,
	},
});

describe("the registered bash", () => {
	it("replaces pi's and offers background", () => {
		expect(tool?.name).toBe("bash");
		expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
			"command",
			"timeout",
			"background",
		]);
	});

	it("runs with the person's command prefix and no editor", async () => {
		await sessionStart?.({ type: "session_start" }, ctx());
		const result = await tool?.execute(
			"t1",
			{ command: 'printf "%s %s %s" "$WIRED" "$GIT_EDITOR" "$PI_SESSION_ID"' },
			undefined,
			undefined,
			ctx(),
		);

		expect(result?.content[0]?.text).toBe("yes true session-1");
	});
});
