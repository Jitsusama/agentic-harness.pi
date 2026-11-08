/**
 * What a ring sounds like on this machine: the ding, what plays it, and
 * the voice that says which session is done.
 *
 * A machine describes its sound in `sound.json` in this extension's
 * configuration folder (`~/.config/pi/agentic-harness.pi/
 * done-chime-widget/` by default), which a Nix module can write with
 * every path in the store. Each field is optional:
 *
 * - `ding`: the sound file played first.
 * - `player`: the command that plays a sound file.
 * - `voice`: on Linux, the piper voice model (its `.onnx.json` beside
 *   it); on macOS, the name of a voice `say` knows.
 * - `piper` and `sox`: the commands that speak a line and lower it, on
 *   Linux.
 * - `pitch`: how far the spoken line is moved, in cents; negative is
 *   lower, and zero leaves the voice as it is.
 *
 * Without the file a Mac still rings, with its own low Submarine sound
 * and the deep Ralph voice, since both come with macOS. Linux has no
 * sound or voice every machine is sure to have, so it rings only once
 * the machine names them. The file is read at each ring, so a change to
 * it reaches every session without a restart.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../lib/internal/paths.ts";
import { isRecord } from "../../lib/internal/record.ts";

/** A machine's sound, each field filled in. */
export interface Sound {
	/** The file played first, or none to play no ding. */
	readonly ding?: string;
	/** What plays a sound file. */
	readonly player: string;
	/** A piper model on Linux, a `say` voice on macOS, or none to say nothing. */
	readonly voice?: string;
	/** What speaks a line into a file, on Linux. */
	readonly piper: string;
	/** What lowers the spoken line, on Linux. */
	readonly sox: string;
	/** How far the spoken line moves, in cents. */
	readonly pitch: number;
}

/** The tools Linux's sound runs, by the names they go by on the PATH. */
const LINUX: Sound = {
	player: "pw-play",
	piper: "piper",
	sox: "sox",
	pitch: 0,
};

/** What every Mac has, so one with no description still rings. */
const DARWIN: Sound = {
	...LINUX,
	// The lowest of the system's alert sounds, a single sonar ping.
	ding: "/System/Library/Sounds/Submarine.aiff",
	player: "afplay",
	// The deepest of the voices macOS ships with.
	voice: "Ralph",
};

/** Where the machine describes its sound. */
export function soundFile(): string {
	return join(configDir("done-chime-widget"), "sound.json");
}

/**
 * The machine's sound on `platform`: each field the description gives
 * that reads, and the platform's default for the rest. A description
 * that's missing or isn't JSON leaves the defaults whole, since a ring
 * has nowhere to say what went wrong.
 */
export function readSound(
	platform: NodeJS.Platform,
	file = soundFile(),
): Sound {
	const defaults = platform === "darwin" ? DARWIN : LINUX;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return defaults;
	}
	if (!isRecord(raw)) return defaults;
	const named = (key: string): string | undefined => {
		const value = raw[key];
		return typeof value === "string" && value !== "" ? value : undefined;
	};
	const ding = named("ding") ?? defaults.ding;
	const voice = named("voice") ?? defaults.voice;
	return {
		...(ding ? { ding } : {}),
		player: named("player") ?? defaults.player,
		...(voice ? { voice } : {}),
		piper: named("piper") ?? defaults.piper,
		sox: named("sox") ?? defaults.sox,
		pitch: Number.isFinite(raw.pitch) ? Number(raw.pitch) : defaults.pitch,
	};
}
