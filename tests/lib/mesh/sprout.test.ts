/**
 * Sprouting a cell from inside pi: `mycelium sprout` asked for the
 * session, and what it answered read.
 */

import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	type Ran,
	type RunProgram,
	runProgram,
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
			`--in=${homedir()}/src/core.nix`,
			"--on=skiff",
			"--from=42P0R4",
			"--",
			"make the launcher faster",
		]);
	});

	it("joins a value that opens with a dash to its flag, so it starts no option", () => {
		expect(
			sproutArguments({ words: "tea", folder: "--help", on: "-x" }),
		).toEqual(["sprout", "-o", "json", "--in=--help", "--on=-x", "--", "tea"]);
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

	it("says a start may have landed when a clean exit answers what it can't read", async () => {
		for (const stdout of ["", '{"Ok":{"Something":1}}\n']) {
			const { run } = answering({ code: 0, stdout, stderr: "" });
			const answer = await sprout({ words: "tea" }, "/home/joel/src", run);
			expect(answer, `after ${JSON.stringify(stdout)}`).toMatchObject({
				ok: false,
				mayLand: true,
			});
		}
	});

	it("says no start landed when a clean exit is the node's refusal", async () => {
		const { run } = answering({
			code: 0,
			stdout: '{"Err":"no such machine"}\n',
			stderr: "",
		});
		const answer = await sprout({ words: "tea" }, "/home/joel/src", run);
		expect(answer).toEqual({ ok: false, reason: "no such machine" });
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

	it("says mycelium's own reason when a failed run's last stdout line isn't JSON", async () => {
		const { run } = answering({
			code: 2,
			stdout: "judging the folder\n",
			stderr: "mycelium sprout: no such folder ~/src/nowhere\n",
		});
		expect(await sprout({ words: "tea" }, "/", run)).toEqual({
			ok: false,
			reason: "mycelium sprout: no such folder ~/src/nowhere",
		});
	});

	it("says a sprout stopped with its turn may still start", async () => {
		const { run } = answering({
			code: null,
			stdout: "",
			stderr: "",
			stopped: true,
		});
		const answer = await sprout({ words: "tea" }, "/", run);
		expect(answer).toMatchObject({ ok: false, mayLand: true });
		expect(!answer.ok && answer.reason).toMatch(/turn was stopped/u);
	});

	it("says mycelium isn't here when there's no such program", async () => {
		const { run } = answering({
			code: null,
			stdout: "",
			stderr: "",
			missing: true,
		});
		const answer = await sprout({ words: "tea" }, "/", run);
		expect(answer).toMatchObject({ ok: false });
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
		expect(!answer.ok && answer.reason).toMatch(
			/answered nothing within \d+ s, so look for it in the launcher's Agents before asking again, since another ask starts a second cell$/u,
		);
	});

	it("says one ended by a signal nobody here sent may still start", async () => {
		const { run } = answering({ code: null, stdout: "", stderr: "" });
		const answer = await sprout({ words: "tea" }, "/", run);
		expect(answer).toMatchObject({ ok: false, mayLand: true });
		expect(!answer.ok && answer.reason).toMatch(
			/was ended before it answered/u,
		);
	});

	it("says one a signal ended after it wrote what can't be read may still start", async () => {
		for (const stdout of ["judging the folder\n", '{"Ok":{"Something":1}}\n']) {
			const { run } = answering({ code: null, stdout, stderr: "" });
			const answer = await sprout({ words: "tea" }, "/", run);
			expect(answer, stdout).toMatchObject({ ok: false, mayLand: true });
		}
	});

	it("says nothing was sprouted when mycelium couldn't be started at all", async () => {
		const { run } = answering({
			code: null,
			stdout: "",
			stderr: "",
			neverRan: "EAGAIN",
		});
		const answer = await sprout({ words: "tea" }, "/", run);
		expect(answer).toEqual({
			ok: false,
			reason:
				"mycelium sprout couldn't be started here (EAGAIN), so nothing was sprouted",
		});
	});

	it("says a session's folder that's gone, never that mycelium is missing", async () => {
		const { run } = answering({
			code: null,
			stdout: "",
			stderr: "",
			noFolder: true,
		});
		const answer = await sprout({ words: "tea" }, "/gone", run);
		expect(answer).toEqual({
			ok: false,
			reason:
				"this session's folder, /gone, is gone, so mycelium can't run from it",
		});
	});

	it("refuses a ~ folder on another machine without running anything", async () => {
		const { run, asked } = answering({ code: 0, stdout: STARTED, stderr: "" });
		const answer = await sprout(
			{ words: "tea", folder: "~/src/core.nix", on: "mac" },
			"/",
			run,
		);
		expect(answer).toMatchObject({ ok: false });
		expect(!answer.ok && answer.reason).toMatch(
			/name the folder in full as it is on mac/u,
		);
		expect(asked).toEqual([]);
	});

	it("refuses words that are only blank without running anything", async () => {
		const { run, asked } = answering({ code: 0, stdout: STARTED, stderr: "" });
		const answer = await sprout({ words: "  " }, "/", run);
		expect(answer).toMatchObject({ ok: false });
		expect(asked).toEqual([]);
	});
});

describe("running a program", () => {
	const patience = { cwd: "/", timeoutMs: 5000 };

	it("answers a real exit's code and what it said on each stream", async () => {
		const ran = await runProgram(
			"sh",
			["-c", "echo out; echo err >&2; exit 3"],
			patience,
		);
		expect(ran).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
	});

	it("says a program that isn't here is missing", async () => {
		const ran = await runProgram("no-such-program-here", [], patience);
		expect(ran).toMatchObject({ code: null, missing: true });
		expect(ran).not.toHaveProperty("noFolder");
	});

	it("says a folder that's gone, rather than a program missing", async () => {
		const ran = await runProgram("sh", ["-c", "exit 0"], {
			...patience,
			cwd: "/no/such/folder/here",
		});
		expect(ran).toMatchObject({ code: null, noFolder: true });
		expect(ran).not.toHaveProperty("missing");
	});

	it("says one that couldn't be started never ran, with the system's reason", async () => {
		const ran = await runProgram("sh", ["-c", "exit 0"], {
			...patience,
			cwd: "/etc/hostname",
		});
		expect(ran).toMatchObject({ code: null, neverRan: "ENOTDIR" });
	});

	it("says one that ran past its patience timed out", async () => {
		const ran = await runProgram("sleep", ["5"], {
			...patience,
			timeoutMs: 50,
		});
		expect(ran).toMatchObject({ code: null, timedOut: true });
		expect(ran).not.toHaveProperty("stopped");
	});

	it("says one its asker stopped was stopped, not timed out", async () => {
		const stopping = new AbortController();
		const running = runProgram("sleep", ["5"], {
			...patience,
			signal: stopping.signal,
		});
		stopping.abort();
		const ran = await running;
		expect(ran).toMatchObject({ code: null, stopped: true });
		expect(ran).not.toHaveProperty("timedOut");
		expect(ran).not.toHaveProperty("neverRan");
	});
});
