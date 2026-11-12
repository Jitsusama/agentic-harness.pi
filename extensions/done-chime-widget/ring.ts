/**
 * The ring itself: a loud, low ding, then a voice on the machine saying
 * which session is done.
 *
 * Linux plays the ding with `pw-play`, PipeWire's own player, while piper
 * speaks the line into a file and sox lowers it; the line plays once the
 * ding is done, so piper's second or two of starting up is heard as the
 * ding ringing out rather than as a pause. macOS plays the ding with
 * `afplay` and has `say` speak the line. Nothing leaves the machine: the
 * voice is a model on disk, never a service.
 *
 * This decides how a ring sounds, never when (`when.ts` does). It answers
 * whether anything was heard, never throws, and stays quiet where a tool
 * is missing or fails, since a machine with no speakers or no voice is
 * an answer, not an error. `PI_NOTIFY=off` silences it, as it silences
 * the desktop's notifications, so no test run makes a sound, and so does
 * the desktop's Do Not Disturb, where the machine names its file.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Exec, spawnExec } from "../../lib/core/exec/index.ts";
import { isQuiet, quietFile } from "./quiet.ts";
import { readSound, type Sound } from "./sound.ts";

/** One program to run, with its arguments. */
export interface Command {
	command: string;
	args: string[];
}

/**
 * How a ring is made: the ding, what is run while it plays to make the
 * spoken line, in order, and what then speaks it. Either half may be
 * missing, where the machine names no ding or no voice.
 */
export interface RingPlan {
	ding?: Command;
	prepare: Command[];
	speak?: Command;
}

/** The parts of the machine a ring depends on, for tests. */
export interface RingDeps {
	/** Defaults to the running platform. */
	platform?: NodeJS.Platform;
	/** Defaults to running each tool unattended, with a clock. */
	exec?: Exec;
	/** Defaults to the process environment. */
	env?: NodeJS.ProcessEnv;
	/** Defaults to the machine's own description (`sound.ts`). */
	sound?: Sound;
	/** Defaults to the clock, for whether a Do Not Disturb has ended. */
	now?: () => number;
}

/**
 * How long any one tool in a ring may take.
 *
 * Piper takes about five seconds from a cold start on a laptop to speak
 * a short line, and each sound plays for a few; a tool still going at
 * thirty seconds is stuck, and nothing waits on a ring anyway.
 */
export const STEP_LIMIT_MS = 30_000;

/**
 * The most words a folder's name is read out in. A worktree's folder runs
 * to a dozen words that tell a listener nothing a session's name wouldn't.
 */
const SPOKEN_WORDS = 4;

/** Where a cut name ends: a single ellipsis, or three periods. */
const CUT_MARK = /(\u2026|\.\.\.)$/;

/**
 * The commands that ring `line` with `sound` on `platform`, making any
 * files in `scratch`; none on a platform with no player it knows.
 */
export function ringPlan(
	sound: Sound,
	line: string,
	platform: NodeJS.Platform,
	scratch: string,
): RingPlan | undefined {
	const ding = sound.ding
		? { ding: { command: sound.player, args: [sound.ding] } }
		: {};
	if (platform === "darwin") {
		const speak = sound.voice
			? { speak: { command: "say", args: ["-v", sound.voice, line] } }
			: {};
		return { ...ding, prepare: [], ...speak };
	}
	if (platform !== "linux" && platform !== "freebsd" && platform !== "openbsd")
		return undefined;
	if (!sound.voice) return { ...ding, prepare: [] };
	const said = join(scratch, "said.wav");
	const low = join(scratch, "low.wav");
	const lowered = sound.pitch !== 0;
	return {
		...ding,
		prepare: [
			// `--` ends the options, so a line that opens with a dash is text.
			{
				command: sound.piper,
				args: ["--model", sound.voice, "--output-file", said, "--", line],
			},
			...(lowered
				? [
						{
							command: sound.sox,
							args: [said, low, "pitch", String(sound.pitch)],
						},
					]
				: []),
		],
		speak: { command: sound.player, args: [lowered ? low : said] },
	};
}

/**
 * Ring `line` out loud, answering whether anything was heard.
 *
 * The ding plays while the line is made, and the line is spoken once
 * both are done; a step that fails ends the voice there and leaves the
 * ding alone. Never throws, and answers false when nothing could play,
 * on a platform it doesn't know, when `PI_NOTIFY=off`, and while the
 * desktop's Do Not Disturb is on.
 */
export async function ring(
	line: string,
	deps: RingDeps = {},
): Promise<boolean> {
	const env = deps.env ?? process.env;
	if (env.PI_NOTIFY === "off") return false;
	const platform = deps.platform ?? process.platform;
	const sound = deps.sound ?? readSound(platform);
	const quiet = sound.quiet ? quietFile(sound.quiet, env) : undefined;
	if (quiet && isQuiet(quiet, (deps.now ?? Date.now)())) return false;
	const exec = deps.exec ?? spawnExec({ timeoutMs: STEP_LIMIT_MS });
	const scratch = mkdtempSync(join(tmpdir(), "pi-done-chime-"));
	try {
		const plan = ringPlan(sound, line, platform, scratch);
		if (!plan) return false;
		const [dinged, prepared] = await Promise.all([
			plan.ding ? ran(exec, plan.ding) : false,
			runInOrder(exec, plan.prepare),
		]);
		const spoke = prepared && plan.speak ? await ran(exec, plan.speak) : false;
		return dinged || spoke;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** What the ring says when `name`'s run is done. */
export function doneLine(name: string): string {
	return `${name} is ready.`;
}

/**
 * The name a ring says a session by: its own name, which quest-workflow
 * sets to the quest's short title, else its folder's name in words when
 * that is short enough to mean something, else "pi".
 */
export function spokenName(name: string | undefined, cwd: string): string {
	const given = sayable(name?.replace(CUT_MARK, "") ?? "");
	if (given) return given;
	const words = basename(cwd)
		.split(/[-_.\s]+/)
		.filter(Boolean);
	const folder = sayable(words.join(" "));
	return folder && words.length <= SPOKEN_WORDS ? folder : "pi";
}

/** `text` without the marks before its first letter or digit. */
function sayable(text: string): string {
	return text.trim().replace(/^[^\p{L}\p{N}]+/u, "");
}

/** Whether `step` ran and said it went well. */
async function ran(exec: Exec, step: Command): Promise<boolean> {
	try {
		return (await exec(step.command, step.args)).code === 0;
	} catch {
		// A tool that can't even start is a machine without it: silence.
		return false;
	}
}

/** Whether every step ran, in order, stopping at the first that didn't. */
async function runInOrder(exec: Exec, steps: Command[]): Promise<boolean> {
	for (const step of steps) {
		if (!(await ran(exec, step))) return false;
	}
	return true;
}
