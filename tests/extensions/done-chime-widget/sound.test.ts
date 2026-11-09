import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	readSound,
	soundFile,
} from "../../../extensions/done-chime-widget/sound.ts";

const made: string[] = [];

/** A sound description holding `text`, in a folder of its own. */
function described(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "done-chime-sound-"));
	made.push(dir);
	const file = join(dir, "sound.json");
	writeFileSync(file, text);
	return file;
}

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true });
});

describe("the machine's sound", () => {
	it("is read from the widget's own configuration folder", () => {
		expect(soundFile()).toMatch(
			/pi\/agentic-harness\.pi\/done-chime-widget\/sound\.json$/,
		);
	});

	it("takes what the machine names", () => {
		const file = described(
			JSON.stringify({
				ding: "/sounds/ding.wav",
				player: "/bin/pw-play",
				voice: "/voices/alan.onnx",
				piper: "/bin/piper",
				sox: "/bin/sox",
				pitch: -300,
			}),
		);
		expect(readSound("linux", file)).toEqual({
			ding: "/sounds/ding.wav",
			player: "/bin/pw-play",
			voice: "/voices/alan.onnx",
			piper: "/bin/piper",
			sox: "/bin/sox",
			pitch: -300,
		});
	});

	it("keeps each default the machine leaves out or gets wrong", () => {
		const file = described(JSON.stringify({ ding: "/d.wav", pitch: "low" }));
		expect(readSound("linux", file)).toEqual({
			ding: "/d.wav",
			player: "pw-play",
			piper: "piper",
			sox: "sox",
			pitch: 0,
		});
	});

	it("has no ding and no voice on Linux until the machine names them", () => {
		const sound = readSound("linux", join(tmpdir(), "no-such-sound.json"));
		expect(sound.ding).toBeUndefined();
		expect(sound.voice).toBeUndefined();
	});

	it("rings with the Mac's own low sound when nothing is named, and says nothing", () => {
		// 9 November: Joel kept only the bell.
		const sound = readSound("darwin", described("not json"));

		expect(sound).toMatchObject({
			ding: "/System/Library/Sounds/Submarine.aiff",
			player: "afplay",
		});
		expect(
			sound.voice,
			"no voice unless the machine names one",
		).toBeUndefined();
	});
});
