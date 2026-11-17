import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import questWorkflow from "../../../extensions/quest-workflow/index.ts";
import { type FakePi, fakePi } from "../../support/fake-pi.ts";

/**
 * What the quest workflow wires into pi when it loads: its tool, its
 * commands and every event it answers. Each lives in a file of its own
 * under wiring/, and index.ts calls each in turn, so a call dropped
 * from index.ts would switch off a whole reason to change (the tool
 * guards, the turn refresh, a session's start and end) with no other
 * test noticing.
 */

let home: string;
let pi: FakePi;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "quest-wiring-"));
	// Every folder pi's state lives in, so loading reads and writes none
	// of the person's own.
	vi.stubEnv("HOME", home);
	vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
	vi.stubEnv("XDG_DATA_HOME", join(home, "data"));
	vi.stubEnv("XDG_STATE_HOME", join(home, "state"));
	vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
	pi = fakePi();
	await questWorkflow(pi);
});

afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("the quest workflow, once loaded", () => {
	it("registers the quest tool", () => {
		expect(pi.recorded.tools.map((tool) => tool.name)).toContain("quest");
	});

	it("registers its two slash commands", () => {
		expect([...pi.recorded.commands.keys()]).toEqual(
			expect.arrayContaining(["quest", "quest-resume"]),
		);
	});

	it.each([
		["tool_call", "the guards each tool call is held to"],
		["agent_before_settle", "the record read-back before a turn settles"],
		["tool_result", "the records a tool call leaves behind"],
		// A turn's end is heard as the next turn starts or the run ends,
		// never on pi's turn_end (lib/internal/session/turn-end.ts).
		["turn_start", "the loaded quest's freshness each turn"],
		["before_agent_start", "the budget and slice before each prompt"],
		["session_start", "a session's start on its quest"],
		["resources_discover", "a spawned session's first words"],
		["session_shutdown", "a session's end on its quest"],
	])("answers %s, for %s", (event) => {
		expect(
			pi.recorded.handlers.get(event)?.length ?? 0,
			`no handler answers ${event}`,
		).toBeGreaterThan(0);
	});
});
