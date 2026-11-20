/**
 * Sprouting a cell from inside pi: `mycelium sprout` asked for the
 * session, and what it answered read.
 */

import { describe, expect, it } from "vitest";
import {
	type Ran,
	type RunProgram,
	sprout,
	sproutArguments,
} from "../../../lib/mesh/sprout.ts";

/** A runner that answers `ran` and keeps what it was asked. */
function answering(ran: Ran): {
	run: RunProgram;
	asked: { program: string; args: readonly string[]; cwd: string }[];
} {
	const asked: { program: string; args: readonly string[]; cwd: string }[] = [];
	return {
		asked,
		run: async (program, args, options) => {
			asked.push({ program, args, cwd: options.cwd });
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

describe("a sprout's arguments", () => {
	it("asks for JSON and puts the words after two dashes, so a dash starts none", () => {
		expect(sproutArguments({ words: "-1 is wrong" })).toEqual([
			"sprout",
			"-o",
			"json",
			"--",
			"-1 is wrong",
		]);
	});

	it("names the folder, the machine and the cell it comes from when given", () => {
		expect(
			sproutArguments({
				words: "make the launcher faster",
				folder: "~/src/core.nix",
				on: "skiff",
				from: "42P0R4",
			}),
		).toEqual([
			"sprout",
			"-o",
			"json",
			"--in",
			"~/src/core.nix",
			"--on",
			"skiff",
			"--from",
			"42P0R4",
			"--",
			"make the launcher faster",
		]);
	});

	it("leaves out a folder or machine given as blank", () => {
		expect(sproutArguments({ words: "tea", folder: " ", on: "" })).toEqual([
			"sprout",
			"-o",
			"json",
			"--",
			"tea",
		]);
	});
});

describe("sprouting", () => {
	it("runs mycelium in the session's folder and reads where it started", async () => {
		const { run, asked } = answering({
			code: 0,
			stdout: `${STARTED}\n`,
			stderr: "",
		});
		const answer = await sprout({ words: "tea" }, "/home/joel/src", run);
		expect(asked[0]?.program).toBe("mycelium");
		expect(asked[0]?.cwd).toBe("/home/joel/src");
		expect(answer).toEqual({
			ok: true,
			started: {
				machine: "skiff",
				held: "01JHELD",
				folder: "/home/joel/src/core.nix",
				attach: ["mycelium", "attach", "01JHELD"],
			},
		});
	});

	it("says the node's refusal", async () => {
		const { run } = answering({
			code: 1,
			stdout: `${JSON.stringify({ Err: "no machine named kestrel" })}\n`,
			stderr: "",
		});
		expect(await sprout({ words: "tea" }, "/", run)).toEqual({
			ok: false,
			reason: "no machine named kestrel",
		});
	});

	it("says what mycelium refused before asking the node", async () => {
		const { run } = answering({
			code: 1,
			stdout: "",
			stderr: "mycelium sprout: a sprout never starts in home\n",
		});
		expect(await sprout({ words: "tea" }, "/", run)).toEqual({
			ok: false,
			reason: "mycelium sprout: a sprout never starts in home",
		});
	});

	it("says mycelium isn't here when there's no such program", async () => {
		const { run } = answering({
			code: null,
			stdout: "",
			stderr: "",
			missing: true,
		});
		const answer = await sprout({ words: "tea" }, "/", run);
		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.reason).toMatch(/mycelium isn't installed/u);
	});

	it("says a sprout that ran out of time may still start", async () => {
		const { run } = answering({
			code: null,
			stdout: "",
			stderr: "",
			timedOut: true,
		});
		const answer = await sprout({ words: "tea" }, "/", run);
		expect(answer).toMatchObject({ ok: false, mayLand: true });
	});

	it("refuses words that are only blank without running anything", async () => {
		const { run, asked } = answering({ code: 0, stdout: STARTED, stderr: "" });
		const answer = await sprout({ words: "  " }, "/", run);
		expect(answer.ok).toBe(false);
		expect(asked).toEqual([]);
	});
});
