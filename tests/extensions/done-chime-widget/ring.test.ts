import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	doneLine,
	ring,
	ringPlan,
	spokenName,
} from "../../../extensions/done-chime-widget/ring.ts";
import type { Sound } from "../../../extensions/done-chime-widget/sound.ts";
import type { Exec } from "../../../lib/core/exec/index.ts";

/** An exec that records what it was asked to run, failing `failing`. */
function recording(failing?: string): {
	exec: Exec;
	calls: [string, string[]][];
} {
	const calls: [string, string[]][] = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, args]);
		return { code: command === failing ? 1 : 0, stdout: "", stderr: "" };
	};
	return { exec, calls };
}

const LINUX: Sound = {
	ding: "/sounds/ding.wav",
	player: "/bin/pw-play",
	voice: "/voices/alan.onnx",
	piper: "/bin/piper",
	sox: "/bin/sox",
	pitch: -300,
};

const MAC: Sound = {
	ding: "/System/Library/Sounds/Submarine.aiff",
	player: "afplay",
	voice: "Ralph",
	piper: "piper",
	sox: "sox",
	pitch: 0,
};

const ON: NodeJS.ProcessEnv = {};

describe("the ring's plan", () => {
	it("plays the ding, then speaks the line piper said, pitched down by sox", () => {
		expect(ringPlan(LINUX, "Chime is ready.", "linux", "/scratch")).toEqual({
			ding: { command: "/bin/pw-play", args: ["/sounds/ding.wav"] },
			prepare: [
				{
					command: "/bin/piper",
					args: [
						"--model",
						"/voices/alan.onnx",
						"--output-file",
						"/scratch/said.wav",
						"--",
						"Chime is ready.",
					],
				},
				{
					command: "/bin/sox",
					args: ["/scratch/said.wav", "/scratch/low.wav", "pitch", "-300"],
				},
			],
			speak: { command: "/bin/pw-play", args: ["/scratch/low.wav"] },
		});
	});

	it("plays piper's line as it is when the voice keeps its own pitch", () => {
		const plan = ringPlan({ ...LINUX, pitch: 0 }, "Ready.", "linux", "/s");
		expect(plan?.prepare.map((step) => step.command)).toEqual(["/bin/piper"]);
		expect(plan?.speak).toEqual({
			command: "/bin/pw-play",
			args: ["/s/said.wav"],
		});
	});

	it("plays the ding with afplay and speaks with say on a Mac", () => {
		expect(ringPlan(MAC, "Chime is ready.", "darwin", "/scratch")).toEqual({
			ding: {
				command: "afplay",
				args: ["/System/Library/Sounds/Submarine.aiff"],
			},
			prepare: [],
			speak: { command: "say", args: ["-v", "Ralph", "Chime is ready."] },
		});
	});

	it("only dings where the machine names no voice", () => {
		const plan = ringPlan({ ...LINUX, voice: undefined }, "R.", "linux", "/s");
		expect(plan).toEqual({
			ding: { command: "/bin/pw-play", args: ["/sounds/ding.wav"] },
			prepare: [],
		});
	});

	it("has nothing to play on a platform it doesn't know", () => {
		expect(ringPlan(LINUX, "Ready.", "win32", "/s")).toBeUndefined();
	});
});

describe("ringing", () => {
	it("dings, makes the line, then speaks it once the ding is done", async () => {
		const { exec, calls } = recording();
		const rang = await ring("Chime is ready.", {
			platform: "linux",
			exec,
			env: ON,
			sound: LINUX,
		});
		expect(rang, "a ring with every tool there answers that it rang").toBe(
			true,
		);
		expect(calls.map(([command]) => command)).toEqual([
			"/bin/pw-play",
			"/bin/piper",
			"/bin/sox",
			"/bin/pw-play",
		]);
		expect(calls.at(-1)?.[1][0]).toMatch(/low\.wav$/);
	});

	it("leaves nothing behind in its scratch folder", async () => {
		const { exec, calls } = recording();
		await ring("Ready.", { platform: "linux", exec, env: ON, sound: LINUX });
		const said = calls[1][1][3];
		const scratch = said.replace(/said\.wav$/, "");
		expect(existsSync(scratch), `${scratch} is removed`).toBe(false);
	});

	it("still dings when the voice can't be made, and says nothing", async () => {
		const { exec, calls } = recording("/bin/piper");
		const rang = await ring("Ready.", {
			platform: "linux",
			exec,
			env: ON,
			sound: LINUX,
		});
		expect(rang, "a ding with no voice still answers that it rang").toBe(true);
		expect(calls.map(([command]) => command)).toEqual([
			"/bin/pw-play",
			"/bin/piper",
		]);
	});

	it("answers false, silently, when nothing can play", async () => {
		const { exec } = recording("/bin/pw-play");
		const rang = await ring("Ready.", {
			platform: "linux",
			exec,
			env: ON,
			sound: { ...LINUX, voice: undefined },
		});
		expect(rang, "a ring with no player answers that it did not ring").toBe(
			false,
		);
	});

	it("answers false rather than throwing when running a tool throws", async () => {
		const exec: Exec = async () => {
			throw new Error("spawn failed");
		};
		expect(
			await ring("Ready.", { platform: "linux", exec, env: ON, sound: LINUX }),
			"a ring whose tools throw answers that it did not ring",
		).toBe(false);
	});

	it("runs nothing when PI_NOTIFY is off", async () => {
		const { exec, calls } = recording();
		const rang = await ring("Ready.", {
			platform: "linux",
			exec,
			env: { PI_NOTIFY: "off" },
			sound: LINUX,
		});
		expect(rang, "a ring with PI_NOTIFY off answers that it did not ring").toBe(
			false,
		);
		expect(calls).toEqual([]);
	});

	it("is silenced for the whole test suite", async () => {
		const { exec, calls } = recording();
		await ring("Ready.", { platform: "linux", exec, sound: LINUX });
		expect(calls).toEqual([]);
	});
});

describe("what the ring says", () => {
	it("names the session and says it is ready", () => {
		expect(doneLine("Done chime")).toBe("Done chime is ready.");
	});

	it("names a session by its name, which a quest sets to its short title", () => {
		expect(spokenName("Agentic loop", "/work/tree")).toBe("Agentic loop");
	});

	it("drops the mark a cut name ends with", () => {
		expect(spokenName("Speak When Done\u2026", "/w")).toBe("Speak When Done");
	});

	it("names an unnamed session by its folder, in words", () => {
		expect(spokenName(undefined, "/home/j/src/core.nix")).toBe("core nix");
	});

	it("says pi rather than read out a folder too long to mean anything", () => {
		expect(
			spokenName(
				undefined,
				"/trees/worktree-github-Jitsusama-agentic-harness.pi-a-finished-run-rings",
			),
		).toBe("pi");
	});

	it("never opens with a dash a speaker could read as an option", () => {
		expect(spokenName("--verbose", "/w")).toBe("verbose");
	});
});
