/**
 * The journal's four halves agree, and are checked where they meet.
 *
 * A reviewer records a finding through a tool in a pack, loaded by
 * path, permitted by name, writing to a file named in an environment
 * variable. Four facts, spread across a library, an extension, a
 * supervisor script and a pack, and three of the four live in
 * different processes that never speak. Three are now one constant
 * each, which is the real fix; these are the joins a constant cannot
 * make, because a shared name still does not prove there is a file at
 * the path or a tool answering to the name.
 *
 * Worth a gate of its own because every way this breaks is silent. The
 * reviewer is told to call a tool, nothing registers it or nothing
 * reads what it writes, the round comes back with an empty journal,
 * and an empty journal is indistinguishable from a reviewer that had
 * nothing to record. Three recovery paths now rest on this file.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	JOURNAL_PACK_PATH,
	JOURNAL_PATH_VAR,
	JOURNAL_TOOL_NAME,
} from "../../lib/subagent/runpi/journal.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const packSource = () => readFileSync(join(ROOT, JOURNAL_PACK_PATH), "utf8");

describe("the pack a reviewer records through", () => {
	it("is where the constant says it is", () => {
		// The extension joins this onto its own location to build the
		// --extension argument. Wrong, pi fails to load a pack and the
		// reviewer's contract tells it to call a tool nothing has.
		expect(existsSync(join(ROOT, JOURNAL_PACK_PATH))).toBe(true);
	});

	it("is not under a directory pi scans", () => {
		// A pack is loaded into a subagent by path and must never be
		// picked up by the session that dispatched one: this tool
		// belongs to the reviewer, not to the person running the round.
		expect(JOURNAL_PACK_PATH.startsWith("packs/")).toBe(true);
	});

	it("registers the tool the dispatcher permits by name", () => {
		// Pi's --tools flag is an allowlist covering extension tools, so
		// the dispatcher adds this name to any non-empty palette. A pack
		// registering something else is denied silently.
		expect(packSource()).toContain("JOURNAL_TOOL_NAME");
		expect(packSource()).not.toMatch(/name:\s*["']record_finding["']/);
	});

	it("reads the variable the supervisor writes, by the same name", () => {
		expect(packSource()).toContain("JOURNAL_PATH_VAR");
		expect(packSource()).not.toContain(`"${JOURNAL_PATH_VAR}"`);
	});
});

describe("the supervisor that names the file", () => {
	it("passes it under the shared name and nowhere spells it again", () => {
		const source = readFileSync(
			join(ROOT, "lib/subagent/runpi/supervisor.mjs"),
			"utf8",
		);

		expect(source).toContain("JOURNAL_PATH_VAR");
		expect(source).not.toContain(`SUBAGENT_JOURNAL_PATH:`);
	});
});

describe("the names themselves", () => {
	it("are the ones every reviewer already in flight expects", () => {
		// These cross a process boundary and an on-disk artifact, so
		// changing one is not a refactor: a round started before the
		// change is collected after it. Pinned literally, so that
		// decision is made on purpose rather than by a rename.
		expect(JOURNAL_TOOL_NAME).toBe("record_finding");
		expect(JOURNAL_PATH_VAR).toBe("SUBAGENT_JOURNAL_PATH");
	});
});
