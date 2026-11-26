/**
 * mesh_sprout's answer: where the new cell started and how to join it,
 * tied to the cell that asked, or why nothing started.
 */

import { describe, expect, it } from "vitest";
import { sproutFrom } from "../../../extensions/mesh-workflow/tools/sprout.ts";
import type { Ran, RunProgram } from "../../../lib/mesh/sprout.ts";

/** A runner that answers `ran` and keeps the arguments it was given. */
function answering(ran: Ran): { run: RunProgram; args: (readonly string[])[] } {
	const args: (readonly string[])[] = [];
	return {
		args,
		run: async (_program, given) => {
			args.push(given);
			return ran;
		},
	};
}

const STARTED = JSON.stringify({
	Ok: {
		Started: {
			machine: "skiff",
			held: "01JHELD",
			folder: "/home/joel/src/core.nix",
			attach: ["mycelium", "attach", "01JHELD"],
		},
	},
});

/** The text an answer says. */
const said = (answer: Awaited<ReturnType<typeof sproutFrom>>): string =>
	answer.content.map((part) => part.text).join("");

describe("mesh_sprout", () => {
	it("says where it started, that it's tied here, and how to join it", async () => {
		const { run, args } = answering({ code: 0, stdout: STARTED, stderr: "" });
		const answer = await sproutFrom(
			{ words: "make the launcher faster", machine: "skiff" },
			"/home/joel/src",
			"42P0R4",
			run,
		);
		expect(args[0]).toEqual([
			"sprout",
			"-o",
			"json",
			"--on=skiff",
			"--from=42P0R4",
			"--",
			"make the launcher faster",
		]);
		expect(said(answer)).toMatch(
			/Sprouted on skiff in \/home\/joel\/src\/core\.nix/u,
		);
		expect(said(answer)).toMatch(
			/A quest it makes, it asks to tie to this cell, 42P0R4, on the map as it starts; one it joins, this start doesn't tie\. Until the map shows the tie, it isn't there/u,
		);
		expect(said(answer)).toMatch(/mycelium attach 01JHELD/u);
	});

	it("ties nothing from a session off the mesh", async () => {
		const { run, args } = answering({ code: 0, stdout: STARTED, stderr: "" });
		const answer = await sproutFrom({ words: "tea" }, "/", undefined, run);
		expect(
			args[0]?.some((arg) => arg.startsWith("--from")),
			`no argument ties it to a session: ${JSON.stringify(args[0])}`,
		).toBe(false);
		expect(said(answer)).not.toMatch(/tie|this cell/u);
	});

	it("says why nothing was sprouted, in mycelium's words", async () => {
		const { run } = answering({
			code: 1,
			stdout: "",
			stderr: "mycelium sprout: that machine has no such folder\n",
		});
		const answer = await sproutFrom(
			{ words: "tea", folder: "~/src/gone" },
			"/",
			"42P0R4",
			run,
		);
		expect(said(answer)).toBe(
			"⊘ Nothing was sprouted: mycelium sprout: that machine has no such folder",
		);
	});

	it("says a start that ran out of time may still land", async () => {
		const { run } = answering({
			code: null,
			stdout: "",
			stderr: "",
			timedOut: true,
		});
		const answer = await sproutFrom({ words: "tea" }, "/", "42P0R4", run);
		expect(answer.details).toEqual({ mayLand: true });
		expect(said(answer)).toMatch(
			/^The sprout may have started; .*look for it in the launcher's Agents before asking again, since another ask starts a second cell\.$/u,
		);
		expect(said(answer)).not.toMatch(/Nothing was sprouted/u);
	});
});
