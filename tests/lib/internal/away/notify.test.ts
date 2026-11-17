import { describe, expect, it } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import {
	notify,
	notifyCommand,
	withdrawNotice,
} from "../../../../lib/internal/away/notify.ts";
import { at } from "../../../support/at.ts";

/**
 * An exec that records what it was asked to run and answers `code`,
 * printing `stdout`, or what `answer` says for each call.
 */
function recording(
	code = 0,
	stdout = "",
	answer?: (command: string, args: string[]) => number,
): { exec: Exec; calls: [string, string[]][] } {
	const calls: [string, string[]][] = [];
	const exec: Exec = async (command, args) => {
		calls.push([command, args]);
		return { code: answer?.(command, args) ?? code, stdout, stderr: "" };
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
		expect(shown, "notify says it showed the notification").toEqual({});
		expect(calls).toEqual([
			[
				"notify-send",
				[
					"--app-name=pi",
					"--urgency=critical",
					"--print-id",
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
		const [command, args] = at(calls, 0);
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
			"--print-id",
			"--",
			"-t",
		]);
	});

	const HINT = "--hint=string:x-cell:mycelium:cell/1C8A2F0E";

	it("names the cell it is from as a hint among the options", () => {
		const args =
			notifyCommand({ title: "t", cell: "1C8A2F0E" }, "linux")?.args ?? [];
		expect(args).toContain(HINT);
		expect(args.indexOf(HINT), "before the -- that ends them").toBeLessThan(
			args.indexOf("--"),
		);
	});

	it("sends no hint for no address, or one not shaped as one", () => {
		for (const cell of [undefined, "", "1C8A/talk", "1c8a2f0e"]) {
			expect(
				notifyCommand({ title: "t", cell }, "linux")?.args.join(" "),
				`no hint for ${cell}`,
			).not.toContain("x-cell");
		}
	});

	it("sends no hint on macOS, whose notices have nowhere to carry one", () => {
		expect(
			notifyCommand({ title: "t", cell: "1C8A2F0E" }, "darwin")?.args.join(" "),
		).not.toContain("x-cell");
	});

	it("keeps the hint when an old notify-send is asked again without --print-id", async () => {
		const { exec, calls } = recording(0, "", (_command, args) =>
			args.includes("--print-id") ? 1 : 0,
		);
		await notify(
			{ title: "t", cell: "1C8A2F0E" },
			{ platform: "linux", exec, env: ON },
		);
		expect(calls.map(([, args]) => args.includes(HINT))).toEqual([true, true]);
	});

	it("answers false when the notifier refuses or is missing", async () => {
		const { exec } = recording(1);
		expect(
			await notify({ title: "t" }, { platform: "linux", exec, env: ON }),
			"a notify-send that exits 1 showed nothing",
		).toBeUndefined();
	});

	it("answers false rather than throwing when running it throws", async () => {
		const exec: Exec = async () => {
			throw new Error("spawn failed");
		};
		expect(
			await notify({ title: "t" }, { platform: "linux", exec, env: ON }),
			"a notifier that could not be started showed nothing",
		).toBeUndefined();
	});

	it("runs nothing on a platform with no notifier", async () => {
		const { exec, calls } = recording();
		expect(
			await notify({ title: "t" }, { platform: "win32", exec, env: ON }),
			"nothing is shown on win32, which has no notifier",
		).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("runs nothing when PI_NOTIFY is off", async () => {
		const { exec, calls } = recording();
		const shown = await notify(
			{ title: "t" },
			{ platform: "linux", exec, env: { PI_NOTIFY: "off" } },
		);
		expect(shown, "nothing is shown with PI_NOTIFY off").toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("is silenced for the whole test suite", async () => {
		const { exec, calls } = recording();
		await notify({ title: "t" }, { platform: "linux", exec });
		expect(calls).toEqual([]);
	});

	it("answers the id the desktop gave, to take the notice back by", async () => {
		const { exec } = recording(0, "42\n");
		expect(
			await notify({ title: "t" }, { platform: "linux", exec, env: ON }),
			"notify-send printed 42",
		).toEqual({ id: 42 });
	});

	// libnotify added --print-id in 0.7.10; an older one refuses it.
	it("shows it without an id where notify-send refuses to print one", async () => {
		const { exec, calls } = recording(0, "", (_command, args) =>
			args.includes("--print-id") ? 1 : 0,
		);
		const shown = await notify(
			{ title: "t" },
			{ platform: "linux", exec, env: ON },
		);
		expect(shown, "shown, with no id to take it back by").toEqual({});
		expect(calls.map(([, args]) => args.includes("--print-id"))).toEqual([
			true,
			false,
		]);
	});
});

describe("withdrawNotice", () => {
	it("closes the notice by its id over the session bus", async () => {
		const { exec, calls } = recording();
		expect(
			await withdrawNotice({ id: 7 }, { platform: "linux", exec, env: ON }),
			"busctl closed it",
		).toBe(true);
		expect(calls).toEqual([
			[
				"busctl",
				[
					"--user",
					"call",
					"org.freedesktop.Notifications",
					"/org/freedesktop/Notifications",
					"org.freedesktop.Notifications",
					"CloseNotification",
					"u",
					"7",
				],
			],
		]);
	});

	it("tries gdbus where busctl is missing", async () => {
		const calls: string[] = [];
		const exec: Exec = async (command) => {
			calls.push(command);
			if (command === "busctl") throw new Error("spawn busctl ENOENT");
			return { code: 0, stdout: "", stderr: "" };
		};
		expect(
			await withdrawNotice({ id: 7 }, { platform: "linux", exec, env: ON }),
			"gdbus closed it",
		).toBe(true);
		expect(calls).toEqual(["busctl", "gdbus"]);
	});

	it("answers false where nothing can take it back", async () => {
		const { exec, calls } = recording();
		const env = ON;
		expect(
			await withdrawNotice({ id: 7 }, { platform: "darwin", exec, env }),
			"macOS notices have no id to close",
		).toBe(false);
		expect(
			await withdrawNotice({}, { platform: "linux", exec, env }),
			"a notice shown without an id can't be closed",
		).toBe(false);
		expect(
			await withdrawNotice({ id: 7 }, { platform: "linux", exec }),
			"the suite's PI_NOTIFY=off closes nothing",
		).toBe(false);
		expect(calls).toEqual([]);
	});
});
