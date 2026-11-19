/**
 * What reads as asking the person to end a machine's sessions: a log
 * out, a reboot, a restart or shutdown of a machine, or a switch of
 * users, said as an ask, and which machines it names. A mention of one
 * that already happened, or will, asks nothing.
 */

import { describe, expect, it } from "vitest";
import {
	asksInLabel,
	asksInProse,
	mayAsk,
} from "../../../../lib/internal/session-ending/asks.ts";

const MACHINES = ["optimus", "equilibrius"];

const acts = (text: string) => asksInProse(text, MACHINES).map((a) => a.act);
const named = (text: string) =>
	asksInProse(text, MACHINES).map((a) => a.machines);

describe("a reply that asks", () => {
	it.each([
		["Please log out of macOS on equilibrius.", "log out"],
		["Log out and back in to pick up the new group.", "log out"],
		["Reboot optimus when you can.", "reboot"],
		["When you're ready, restart your laptop.", "restart"],
		["Could you shut down equilibrius tonight?", "shut down"],
		["You'll need to switch users to test the second account.", "switch users"],
		["The new kernel needs a reboot to take.", "reboot"],
		["May I ask Joel to reboot optimus?", "reboot"],
		["1. Restart the machine.", "restart"],
		["Once you've rebooted, check the mic.", "reboot"],
		["Go ahead and power off the computer.", "shut down"],
		[
			"Joel: sign out of your session on optimus, then sign back in.",
			"log out",
		],
		["If the mic is still dead, reboot optimus.", "reboot"],
		["Try logging out and back in.", "log out"],
		["Restart now to finish the update.", "restart"],
		["- [ ] Reboot optimus", "reboot"],
		["Run `sudo reboot` on equilibrius.", "reboot"],
		["Run `systemctl poweroff` there.", "shut down"],
		["Restart on equilibrius.", "restart"],
	])("%s", (text, act) => {
		expect(acts(text)).toEqual([act]);
	});

	it("names the machines its sentence names, and none when it names none", () => {
		expect(named("Please log out of macOS on equilibrius.")).toEqual([
			["equilibrius"],
		]);
		expect(named("Please reboot optimus and equilibrius.")).toEqual([
			["optimus", "equilibrius"],
		]);
		expect(named("Please reboot. Optimus is fine.")).toEqual([[]]);
	});

	it("reads a machine named in another case", () => {
		expect(named("Reboot Optimus now.")).toEqual([["optimus"]]);
	});
});

describe("a reply that only mentions one", () => {
	it.each([
		"A log-out on equilibrius ended five sessions.",
		"After the next reboot, the launcher takes the new theme.",
		"The mic stopped working since the last reboot.",
		"Restart the shell to pick up the new bar.",
		"Restart pi rather than reload it after an upgrade.",
		"Log out of gh and log back in with the new scope.",
		"Sign off on the pull request once the checks pass.",
		"It survives a reboot, as the test shows.",
		"Switch to the users tab in the settings.",
		"Could you check whether the reboot fixed the mic?",
		"A log-out on equilibrius ended five sessions when you were away.",
		"Once you asked for it, the reboot ended them all.",
		"Please reboot the router.",
		"Restart the shell now.",
		"The command `reboot` ended them.",
	])("%s", (text) => {
		expect(acts(text)).toEqual([]);
	});
});

describe("a command in fenced code", () => {
	it.each([
		["Type this:\n\n```sh\nsudo reboot\n```", "reboot"],
		["```\n$ systemctl poweroff\n```", "shut down"],
		["```\nloginctl terminate-user jitsusama\n```", "log out"],
		["```\nniri msg action quit\n```", "log out"],
	])("%s asks", (text, act) => {
		expect(acts(text)).toEqual([act]);
	});

	it("names the machine an ssh in front of it reaches", () => {
		expect(named("```\nssh equilibrius sudo shutdown -r now\n```")).toEqual([
			["equilibrius"],
		]);
	});

	it("names none for an ssh host the node doesn't list, so every machine is checked", () => {
		expect(named("```\nssh joel@10.0.0.7 sudo reboot\n```")).toEqual([[]]);
		expect(named("```\nssh -p 22 eq sudo reboot\n```")).toEqual([[]]);
	});

	it("asks nothing of a fence in a language that isn't a shell's", () => {
		expect(acts("```yaml\nreboot: true\n```")).toEqual([]);
		expect(acts("```ts\nshutdown();\n```")).toEqual([]);
	});

	it("asks nothing for code that only names one", () => {
		expect(acts("```ts\nconst reboot = false;\n```")).toEqual([]);
	});

	it("reads prose around the code as prose", () => {
		expect(
			acts("A reboot ended them.\n\n```sh\nls\n```\n\nReboot optimus now."),
		).toEqual(["reboot"]);
	});
});

describe("a label, choice or title, which is the ask itself", () => {
	it.each([
		["Reboot now", "reboot"],
		["Log out", "log out"],
		["Restart now", "restart"],
		["Shut down", "shut down"],
		["Restart the laptop now", "restart"],
	])("%s asks", (text, act) => {
		expect(asksInLabel(text, MACHINES).map((a) => a.act)).toEqual([act]);
	});

	it("still asks nothing of a restart that ends no machine", () => {
		expect(asksInLabel("Restart the shell", MACHINES)).toEqual([]);
	});

	it("asks nothing where the act only names a time", () => {
		expect(asksInLabel("After the reboot", MACHINES)).toEqual([]);
		expect(asksInLabel("Since the last log-out", MACHINES)).toEqual([]);
	});
});

describe("the cheap first look", () => {
	it("passes text with no act word in it without a closer read", () => {
		expect(mayAsk("Landed #1824; nothing to try.")).toBe(false);
		expect(mayAsk("Please reboot.")).toBe(true);
		expect(mayAsk("```\nloginctl terminate-session 3\n```")).toBe(true);
		expect(mayAsk("```\nsystemctl kexec\n```")).toBe(true);
		expect(mayAsk("```\npkill niri\n```")).toBe(true);
	});
});
