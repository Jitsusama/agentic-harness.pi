import { describe, expect, it } from "vitest";
import type { Exec } from "../../../lib/core/exec/index.ts";
import { notify, notifyCommand } from "../../../lib/internal/notify.ts";

/** An exec that records what it was asked to run and answers `code`. */
function recording(code = 0): { exec: Exec; calls: [string, string[]][] } {
	const calls: [string, string[]][] = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, args]);
		return { code, stdout: "", stderr: "" };
	};
	return { exec, calls };
}

const ON: NodeJS.ProcessEnv = {};

describe("notify", () => {
	it("shows a notification through notify-send on Linux", async () => {
		const { exec, calls } = recording();
		const shown = await notify(
			{ title: "Needs you", body: "Publish 0.14.0", urgency: "critical" },
			{ platform: "linux", exec, env: ON },
		);
		expect(shown).toBe(true);
		expect(calls).toEqual([
			[
				"notify-send",
				[
					"--app-name=pi",
					"--urgency=critical",
					"--",
					"Needs you",
					"Publish 0.14.0",
				],
			],
		]);
	});

	it("passes the text to osascript as arguments, never as script", async () => {
		const { exec, calls } = recording();
		const title = 'Say "hi" \\ end tell';
		await notify({ title, body: "b" }, { platform: "darwin", exec, env: ON });
		const [command, args] = calls[0];
		expect(command).toBe("osascript");
		expect(args.slice(-2)).toEqual([title, "b"]);
		const script = args.filter((_, i) => args[i - 1] === "-e").join("\n");
		expect(script).not.toContain(title);
	});

	it("plays a sound on macOS only when it is critical", () => {
		const sound = (urgency: "normal" | "critical") =>
			notifyCommand({ title: "t", urgency }, "darwin")?.args.join(" ");
		expect(sound("critical")).toContain("sound name");
		expect(sound("normal")).not.toContain("sound name");
	});

	it("defaults to normal urgency and leaves an absent body out", () => {
		expect(notifyCommand({ title: "-t" }, "linux")?.args).toEqual([
			"--app-name=pi",
			"--urgency=normal",
			"--",
			"-t",
		]);
	});

	it("answers false when the notifier refuses or is missing", async () => {
		const { exec } = recording(1);
		expect(
			await notify({ title: "t" }, { platform: "linux", exec, env: ON }),
		).toBe(false);
	});

	it("answers false rather than throwing when running it throws", async () => {
		const exec: Exec = async () => {
			throw new Error("spawn failed");
		};
		expect(
			await notify({ title: "t" }, { platform: "linux", exec, env: ON }),
		).toBe(false);
	});

	it("runs nothing on a platform with no notifier", async () => {
		const { exec, calls } = recording();
		expect(
			await notify({ title: "t" }, { platform: "win32", exec, env: ON }),
		).toBe(false);
		expect(calls).toEqual([]);
	});

	it("runs nothing when PI_NOTIFY is off", async () => {
		const { exec, calls } = recording();
		const shown = await notify(
			{ title: "t" },
			{ platform: "linux", exec, env: { PI_NOTIFY: "off" } },
		);
		expect(shown).toBe(false);
		expect(calls).toEqual([]);
	});

	it("is silenced for the whole test suite", async () => {
		const { exec, calls } = recording();
		await notify({ title: "t" }, { platform: "linux", exec });
		expect(calls).toEqual([]);
	});
});
