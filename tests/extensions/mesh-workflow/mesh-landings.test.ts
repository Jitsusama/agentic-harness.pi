/**
 * What the mesh tells of a session's landings by itself: a change
 * merged goes, as one fyi, to its repository's network, and nothing
 * else a session lands tells anybody.
 */

import { describe, expect, it } from "vitest";
import { repositoryOf } from "../../../extensions/mesh-workflow/landing-notes.ts";
import { SESSION_LANDED } from "../../../lib/internal/session/landings.ts";
import { MOST_GROUP_CHARS } from "../../../lib/mesh/group.ts";
import { scopesOf } from "../../../lib/mesh/scope.ts";
import { sentOut, startSession } from "./support/mesh.ts";

/** A landing of `ref`, now. */
function landing(ref: string, over: Record<string, string> = {}) {
	return { at: new Date().toISOString(), ref, what: `${ref} landed`, ...over };
}

describe("a session's landings", () => {
	it("tells the repository's network of a change it merged, once", async () => {
		const { emit } = await startSession();

		emit(
			SESSION_LANDED,
			landing("agentic-harness.pi#920", {
				what: "Carry Background Jobs Across a Rollover",
				person: "A rollover keeps your background jobs.",
				url: "https://github.com/Jitsusama/agentic-harness.pi/pull/920",
			}),
		);
		// Said again, as a queued merge settling says it.
		emit(SESSION_LANDED, landing("agentic-harness.pi#920"));

		const told = sentOut();
		expect(told, "one note, to the repository's network").toHaveLength(1);
		expect(told[0]).toMatchObject({
			to: ["#repo/agentic-harness-pi"],
			intent: "fyi",
		});
		expect(told[0]?.text).toBe(
			`${told[0]?.from} landed agentic-harness.pi#920, Carry Background Jobs Across a Rollover. For the person: A rollover keeps your background jobs. https://github.com/Jitsusama/agentic-harness.pi/pull/920 Said by the mesh; feedback to ${told[0]?.from}.`,
		);
	});

	it("tells nobody of a plan item ticked", async () => {
		const { emit } = await startSession();

		emit(SESSION_LANDED, landing("PLAN-20261030-QMUYBH#15"));

		expect(sentOut(), "a tick is the session's own progress").toEqual([]);
	});

	it("names each repository's network as its scope does", () => {
		expect(repositoryOf(landing("core.nix#5061"))).toBe("#repo/core-nix");
		expect(repositoryOf(landing("world#88"))).toBe("#repo/world");
		expect(repositoryOf(landing("PLAN-20261030-QMUYBH#15"))).toBeUndefined();
		expect(repositoryOf(landing("#12"))).toBeUndefined();
		expect(repositoryOf(landing("notes#draft"))).toBeUndefined();
		// A long name is cut as its sessions' scope is, or none would hear.
		const long = `${"long-name-".repeat(12)}repo`;
		const named = repositoryOf(landing(`${long}#5`)) ?? "";
		expect(named).toBe(scopesOf({ questChain: [], repositories: [long] })[0]);
		// Uncut, both would agree and still name a group nobody keeps
		// (#2243's fourth council, F3).
		expect(
			named.length <= MOST_GROUP_CHARS,
			`${named} runs past the most a group may`,
		).toBe(true);
	});
});
