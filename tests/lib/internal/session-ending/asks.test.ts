/**
 * What reads as asking the person to end a machine's sessions: a log
 * out, a reboot, a restart or shutdown of a machine, or a switch of
 * users, said as an ask, and which machines it names. A mention of one
 * that already happened, or will, or a word against one, asks nothing.
 */

import { describe, expect, it } from "vitest";
import {
	asksInCommand,
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
		["optimus needs a soft reboot to pick it up.", "soft-reboot"],
		["optimus needs a soft restart to pick it up.", "soft-reboot"],
		["Could you do a soft reboot of optimus tonight?", "soft-reboot"],
		["Could you do a soft restart of optimus tonight?", "soft-reboot"],
		["optimus needs a soft  reboot to pick it up.", "soft-reboot"],
		["optimus needs a userspace reboot to pick it up.", "soft-reboot"],
		["optimus needs a user space reboot to pick it up.", "soft-reboot"],
		["Could you do a userspace reboot now?", "soft-reboot"],
		["Could you do a 'soft' reboot of optimus tonight?", "soft-reboot"],
		['Could you do a "soft" reboot of optimus tonight?', "soft-reboot"],
		['Could you "soft" reboot optimus tonight?', "soft-reboot"],
		['Please "soft" reboot optimus.', "soft-reboot"],
		["You'll need to \u201csoft\u201d reboot optimus.", "soft-reboot"],
		["optimus needs a \u201csoft\u201d reboot to pick it up.", "soft-reboot"],
		["Do a quick soft reboot of optimus.", "soft-reboot"],
		["optimus needs a quick soft reboot to pick it up.", "soft-reboot"],
		["optimus needs to be soft rebooted.", "soft-reboot"],
		["- Could you do a soft\n  restart of optimus tonight?", "soft-reboot"],
		["- Could you do a soft\n  reboot of optimus tonight?", "soft-reboot"],
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
		["Once you've logged out, pair the card.", "log out"],
		["Could you try signing out of macOS on equilibrius?", "log out"],
		["To pair the card, log out of macOS on equilibrius.", "log out"],
		["Let's reboot optimus.", "reboot"],
		["Make sure you log out of macOS on equilibrius first.", "log out"],
		["Don't forget to restart your laptop.", "restart"],
		["Next steps: reboot optimus.", "reboot"],
		["Last step: reboot optimus.", "reboot"],
		["I'd suggest rebooting optimus.", "reboot"],
		["I recommend a reboot of optimus.", "reboot"],
		["Mic's dead again, so reboot optimus.", "reboot"],
		["Mind rebooting optimus?", "reboot"],
		["We'll need to reboot equilibrius.", "reboot"],
		["Equilibrius needs to be rebooted.", "reboot"],
		["Could you do a reboot of equilibrius?", "reboot"],
		["Can you give equilibrius a restart?", "restart"],
		["Do a reboot now.", "reboot"],
		["Please restart the iMac.", "restart"],
		["Log out of the current session.", "log out"],
		["* [ ] Reboot optimus", "reboot"],
		["> - Reboot optimus", "reboot"],
		["\u2022 Reboot optimus", "reboot"],
		["| Reboot optimus | tonight |", "reboot"],
		["Please log\u2011out of macOS on equilibrius.", "log out"],
		["You'll\nneed to log out of macOS.", "log out"],
		["On equilibrius, run `sudo reboot`.", "reboot"],
		["You can run `sudo reboot` there.", "reboot"],
		["Choose Log Out from the Apple menu.", "log out"],
		[
			"- **If the BIOS waits:** log out and back in once after that update.",
			"log out",
		],
		['Click "Restart" in the dialog.', "restart"],
		["Try restarting.", "restart"],
		["Save your work and log out of macOS on equilibrius.", "log out"],
		["Choose Restart from the Apple menu.", "restart"],
		["Choose Shut Down… from the Apple menu.", "shut down"],
		["Click the Restart button.", "restart"],
		["Choose Apple menu > Log Out.", "log out"],
		['Click the "Log Out" button.', "log out"],
		['Run "sudo reboot" on equilibrius.', "reboot"],
		["If the restart didn't help, reboot optimus.", "reboot"],
		["If restarting the shell didn't help, reboot optimus.", "reboot"],
		["Reboot optimus: the new kernel only loads at boot.", "reboot"],
		["Reboot optimus: the kernel's in.", "reboot"],
		[
			"Log out of macOS on equilibrius: the card only pairs at the login window.",
			"log out",
		],
		["Please log out/in on equilibrius.", "log out"],
		["Please reboot optimus\u200b now.", "reboot"],
		["Please re\u00adboot optimus.", "reboot"],
		["Log out of macOS: the card only pairs at the login window.", "log out"],
		["Log out and back in: the group only applies at login.", "log out"],
		["- **Next step:** reboot optimus.", "reboot"],
		["- **Reboot optimus:** the kernel only loads at boot.", "reboot"],
		['Click "Save", then click "Restart".', "restart"],
		["Choose `Log Out` from the Apple menu.", "log out"],
	])("%s", (text, act) => {
		expect(mayAsk(text), `the first look reads ${text} closer`).toBe(true);
		expect(acts(text)).toEqual([act]);
	});

	it("reads a pronoun as the machine the sentence or the one before names", () => {
		expect(
			acts("Equilibrius has the new kernel. Could you restart it tonight?"),
		).toEqual(["restart"]);
		expect(acts("Shut it down when you're done with equilibrius.")).toEqual([
			"shut down",
		]);
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

	it("names none when it also acts on a machine it doesn't name, so every one is checked", () => {
		expect(named("Once equilibrius has finished, reboot your laptop.")).toEqual(
			[[]],
		);
		expect(
			named("Log out of macOS here, then check equilibrius picked it up."),
		).toEqual([[]]);
		expect(named("Once equilibrius is free, reboot this machine.")).toEqual([
			[],
		]);
	});

	it("reads a machine named in another case", () => {
		expect(named("Reboot Optimus now.")).toEqual([["optimus"]]);
	});

	it.each([
		[
			"Log out of niri on optimus by running `loginctl terminate-user joel`.",
			"end the user's processes",
		],
		[
			"Log out with `loginctl terminate-user joel`.",
			"end the user's processes",
		],
		["Reboot optimus with `sudo systemctl soft-reboot`.", "soft-reboot"],
		["Please reboot optimus (`systemctl soft-reboot`).", "soft-reboot"],
		[
			"Please log out of niri on optimus. The quickest way is `loginctl terminate-user joel`.",
			"end the user's processes",
		],
		[
			"Reboot optimus. Use `sudo systemctl soft-reboot` so the kernel stays.",
			"soft-reboot",
		],
		[
			"Please log out of niri on optimus:\n\n- `loginctl terminate-user joel`",
			"end the user's processes",
		],
		["Reboot optimus with:\n\n`sudo systemctl soft-reboot`", "soft-reboot"],
		[
			"Log out of niri on optimus with `loginctl terminate-user joel; echo done`.",
			"end the user's processes",
		],
	])("%s asks for what its code does too", (text, act) => {
		expect(acts(text)).toContain(act);
	});

	it.each([
		"Reboot optimus to take the BIOS. Then `ssh equilibrius sudo reboot`.",
		"Reboot optimus, and run `ssh equilibrius sudo reboot`.",
	])("%s asks for its code's act on the code's machine too", (text) => {
		const asks = asksInProse(text, MACHINES);
		expect(
			asks.some(
				(one) => one.act === "reboot" && one.machines.includes("equilibrius"),
			),
			`no reboot reaches equilibrius in ${JSON.stringify(asks)}`,
		).toBe(true);
	});

	it("places code that names no machine on the machines its reply names", () => {
		expect(
			asksInProse(
				"Please log out of niri on optimus. The quickest way is `loginctl terminate-user joel`.",
				MACHINES,
			),
		).toContainEqual(
			expect.objectContaining({
				act: "end the user's processes",
				machines: ["optimus"],
			}),
		);
	});

	it("reads code once beside a worded ask, and none where nothing asks", () => {
		expect(acts("Please run `sudo reboot` on optimus.")).toEqual(["reboot"]);
		expect(
			acts("The guard now refuses `loginctl terminate-user joel` here."),
		).toEqual([]);
	});
});

describe("a reply that only mentions one, or warns against one", () => {
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
		"Please don't reboot optimus while the runs finish.",
		"You must not restart equilibrius yet.",
		"Could you hold off on rebooting optimus until the run ends?",
		"Please avoid logging out of macOS on equilibrius.",
		"Could you check whether rebooting fixed the mic?",
		"Can you tell me if restarting the machine helped?",
		"Could you confirm logging out fixed the keyring?",
		"You should not log out on equilibrius.",
		"Edit the unit, then restart it.",
		"Reboot didn't help either.",
		"If you reboot, five sessions end.",
		"Restart the dev server, then restart it again.",
		"It's not safe to restart the machine yet.",
		"It doesn't need a reboot.",
		"It doesn't seem to need a reboot.",
		"If it doesn't need a reboot, leave it running.",
		"Check the reboot and log-out cases.",
		"Test reboot and logout separately.",
		"When you log out and back in, every pi session on equilibrius ends.",
		"Don't reboot, log out or restart anything while the call runs.",
		"Please restart the dev server after the reboot.",
		"Click Restart on the VS Code notification.",
		"Hit restart on the language server.",
		"Choose Restart Kernel from the Kernel menu.",
		"Cherry-pick the restart fix onto main.",
		"We hit the restart limit again.",
		"Run the tests, which now cover `sudo reboot`.",
	])("%s", (text) => {
		expect(acts(text)).toEqual([]);
	});
});

describe("a reply that talks about one, as the harness's replies do", () => {
	// Each as a session here wrote it in the two days before 19 November.
	it.each([
		"- **Restart:** the background host hasn't restarted yet.",
		"Reboot hold: optimus reboots in about 15 minutes.",
		"Now restart.ts.",
		"Now restart-carry, which restarts a host mid-run:",
		"Once it merges, it needs one more restart.",
		"The session needs restarting, or another session can pick up the steps above.",
		"The hosts pick it up the next time they restart.",
		"Try this after the restart: open several conversations at once.",
		"A test can open both, list one in the stage folder, restart the host so both reload.",
		"It refuses a call that asks Joel to log out, reboot, restart, shut down or switch users on a machine.",
		"Reboot passed on staging-6.",
		"First reboot forced onto the retry.",
		"Nothing needs a reboot sooner.",
		"A Mac key signs with the screen locked, but not once you've logged out.",
		"- **Switch fix (branch fix-switch-signed-out-drop):** written.",
		"Switch 1023 at 00:18 restarted both too.",
		'Prose has to be worded as an ask, such as "Reboot optimus" or "needs a reboot".',
		"Reboot and log-out are still caught and refused.",
		"Arming is the double Return Joel prefers, the same one Log Out, Reboot and Release It use.",
		"Reboot handling landed in #1830.",
		"`restart` now takes a --force flag.",
		"### Restart",
		"## Reboot and Log-Out",
		"Reboot detection works now.",
		"Log-out handling works too.",
		"- **Reboot at 22:29:** someone else did it.",
		"- **Restart and IDs:** does anything restart programs after a fork?",
		"The guard reads each line as it wraps, so a sentence that goes on\nreboot handling and more stays whole.",
	])("%s", (text) => {
		expect(acts(text)).toEqual([]);
	});
});

describe("a command in fenced code", () => {
	it.each([
		["Type this:\n\n```sh\nsudo reboot\n```", "reboot"],
		["```\n$ systemctl poweroff\n```", "shut down"],
		["```\nloginctl terminate-user jitsusama\n```", "end the user's processes"],
		["```\nloginctl kill-user jitsusama\n```", "end the user's processes"],
		["```\nloginctl terminate-session 3\n```", "log out"],
		["```\nniri msg action quit\n```", "log out"],
		["````sh\nsudo reboot\n````", "reboot"],
		["```shell-session\n$ sudo reboot\n```", "reboot"],
		["Then:\n\n    sudo reboot\n", "reboot"],
		["```sh\nsudo init 6\n```", "reboot"],
		[
			"```sh\nosascript -e 'tell app \"System Events\" to restart'\n```",
			"reboot",
		],
		[
			"```sh\nosascript -e 'tell app \"System Events\" to shut down'\n```",
			"shut down",
		],
		["```sh\nsudo launchctl reboot\n```", "reboot"],
		["```sh\nsudo fdesetup authrestart\n```", "reboot"],
		["```sh\nsudo pkill -KILL -u joel\n```", "end the user's processes"],
		["```sh\npkill -KILL -u joel 2>/dev/null\n```", "end the user's processes"],
		["```sh\nkill -9 -1 1234\n```", "end the user's processes"],
		["```sh\nkill -9 1234 -1\n```", "end the user's processes"],
		["```sh\nkill -s KILL -1\n```", "end the user's processes"],
		["```sh\nkill -n 9 -1\n```", "end the user's processes"],
		["```sh\nkill -9 -1\n```", "end the user's processes"],
		["```sh\nkill -- -1\n```", "end the user's processes"],
		["```sh\nkill -9 -1 2>/dev/null\n```", "end the user's processes"],
		["```sh\nkill -9 -1 >/dev/null 2>&1\n```", "end the user's processes"],
		["```sh\nkill -9 -1 # every one\n```", "end the user's processes"],
		["```sh\nsudo systemctl soft-reboot\n```", "soft-reboot"],
		["```sh\nsystemctl isolate soft-reboot.target\n```", "soft-reboot"],
		["```sh\nsudo systemctl isolate soft-reboot\n```", "soft-reboot"],
		["```sh\nsudo systemctl isolate reboot\n```", "reboot"],
		["```sh\nsudo systemctl isolate poweroff\n```", "shut down"],
		[
			"```sh\nbusctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager RebootWithFlags t 4\n```",
			"soft-reboot",
		],
		[
			"```sh\nbusctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager ScheduleShutdown st soft-reboot 0\n```",
			"soft-reboot",
		],
		[
			"```sh\nbusctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager PowerOffWithFlags t 0\n```",
			"shut down",
		],
		["```sh\nsudo systemctl restart display-manager\n```", "log out"],
		["```sh\nswaymsg exit\n```", "log out"],
		["```sh\nhyprctl dispatch exit\n```", "log out"],
		["```sh\nsudo launchctl bootout user/501\n```", "log out"],
		["```sh\nsudo -u root reboot\n```", "reboot"],
		["```sh\nsleep 5 & sudo reboot\n```", "reboot"],
		["```sh\nsh -c 'reboot'\n```", "reboot"],
		["```sh\nnohup sudo reboot\n```", "reboot"],
		["```sh\nenv FOO=1 sudo reboot\n```", "reboot"],
		["```sh\nsudo /sbin/reboot\n```", "reboot"],
		["```sh\nsudo /usr/bin/systemctl poweroff\n```", "shut down"],
		["```sh\nsudo systemctl -i reboot\n```", "reboot"],
		["```sh\nsystemctl --force poweroff\n```", "shut down"],
		["```sh\npkexec reboot\n```", "reboot"],
		["```sh\nsudo su -c reboot\n```", "reboot"],
		["```sh\nsudo systemctl isolate reboot.target\n```", "reboot"],
		["```sh\nsudo systemctl start poweroff.target\n```", "shut down"],
		["```sh\nsystemctl --user restart niri\n```", "log out"],
		["```sh\nsudo systemctl stop gdm\n```", "log out"],
		["```sh\nloginctl terminate-seat seat0\n```", "log out"],
		[
			"```sh\nbusctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager Reboot b false\n```",
			"reboot",
		],
		["```sh\nxfce4-session-logout --logout\n```", "log out"],
		["```sh\nqdbus org.kde.Shutdown /Shutdown logout\n```", "log out"],
		["```sh\ncinnamon-session-quit --logout\n```", "log out"],
		["```sh\nlxqt-leave --logout\n```", "log out"],
		[
			"```sh\nosascript -e 'tell app \"System Events\" to «event aevtrrst»'\n```",
			"reboot",
		],
		["```sh\nsystemctl --user stop niri\n```", "log out"],
		[
			"```sh\nbusctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager TerminateUser u 1000\n```",
			"end the user's processes",
		],
		[
			"```sh\nbusctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUser uss 1000 all 9\n```",
			"end the user's processes",
		],
		[
			"```sh\nbusctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager TerminateSession s 3\n```",
			"log out",
		],
		["```sh\ntimeout 5 sudo reboot\n```", "reboot"],
		[
			"```sh\nsystemd-run --user --on-active=60 systemctl reboot\n```",
			"reboot",
		],
		["```sh\necho | xargs sudo reboot\n```", "reboot"],
		["```sh\nif true; then sudo reboot; fi\n```", "reboot"],
		["```sh\n(sudo reboot)\n```", "reboot"],
	])("%s asks", (text, act) => {
		expect(mayAsk(text), `the first look reads ${text} closer`).toBe(true);
		expect(acts(text)).toEqual([act]);
	});

	it("asks nothing of a command that ends no session", () => {
		expect(acts("```sh\nsudo shutdown -c\n```")).toEqual([]);
		expect(acts("```sh\npkill -u $USER -f vitest\n```")).toEqual([]);
		// Signal 1 to one process, not every process.
		expect(acts("```sh\nkill -1 1234\n```")).toEqual([]);
		expect(acts("```sh\nsudo kill -1 $(pidof nginx)\n```")).toEqual([]);
		// A process group, not every process.
		expect(acts("```sh\nkill -9 -12345\n```")).toEqual([]);
		expect(acts("```sh\n# reboot once this lands\nls\n```")).toEqual([]);
		expect(acts("```\nshutdown of the old node is done.\n```")).toEqual([]);
	});

	it("reads a fence of prose, or of no shell it knows, as prose too", () => {
		expect(
			acts("```markdown\n1. Log out of macOS on equilibrius\n```"),
		).toEqual(["log out"]);
		expect(
			acts("```text\nPlease log out of macOS on equilibrius.\n```"),
		).toEqual(["log out"]);
	});

	it("names the machine an ssh in front of it reaches", () => {
		expect(named("```\nssh equilibrius sudo shutdown -r now\n```")).toEqual([
			["equilibrius"],
		]);
		expect(named("```\nssh equilibrius -t sudo reboot\n```")).toEqual([
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

	it("asks nothing of pasted output that only names one", () => {
		expect(
			acts(
				"```\nreboot   system boot  6.6.1  Tue Nov 18 09:12   still running\nshutdown system down  6.6.1  Mon Nov 17 23:01\n```",
			),
		).toEqual([]);
		expect(
			acts("```console\n$ last -x reboot\nreboot   system boot  6.6.1\n```"),
		).toEqual([]);
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

describe("a command given on its own", () => {
	it("asks when it ends sessions, and not otherwise", () => {
		expect(
			asksInCommand("loginctl terminate-user joel", MACHINES).map((a) => a.act),
		).toEqual(["end the user's processes"]);
		expect(asksInCommand("test -e /run/booted", MACHINES)).toEqual([]);
	});
});

describe("a label, choice or title, which is the ask itself", () => {
	it.each([
		["Reboot now", "reboot"],
		["Log out", "log out"],
		["Restart now", "restart"],
		["Shut down", "shut down"],
		["Restart the laptop now", "restart"],
		["Do a reboot now", "reboot"],
		["Yes, a restart tonight", "restart"],
		["Go with the reboot", "reboot"],
		["Kernel reboot on equilibrius", "reboot"],
		["Userspace reboot now", "soft-reboot"],
		["User space reboot now", "soft-reboot"],
		["Apple menu \u2192 Log Out", "log out"],
	])("%s asks", (text, act) => {
		expect(asksInLabel(text, MACHINES).map((a) => a.act)).toEqual([act]);
	});

	it("still asks nothing of a restart that ends no machine", () => {
		expect(asksInLabel("Restart the shell", MACHINES)).toEqual([]);
	});

	it("asks nothing where the act only qualifies a thing", () => {
		expect(asksInLabel("Keep the reboot check", MACHINES)).toEqual([]);
		expect(asksInLabel("Fix log-out handling", MACHINES)).toEqual([]);
	});

	it("asks nothing of a machine name no machine could have", () => {
		expect(asksInProse("Restart the shell now.", ["", "optimus"])).toEqual([]);
	});

	it("asks nothing where the act only names a time", () => {
		expect(asksInLabel("After the reboot", MACHINES)).toEqual([]);
		expect(asksInLabel("Since the last log-out", MACHINES)).toEqual([]);
	});
});

describe("the cheap first look", () => {
	it("passes text with no act word in it without a closer read", () => {
		const passed = [
			"Landed #1824; nothing to try.",
			"PowerShell is powerful, and the shuttle is halting.",
		];
		const lookedAt = [
			"Please reboot.",
			"```\nloginctl terminate-session 3\n```",
			"```\nsystemctl kexec\n```",
			"```\npkill niri\n```",
			"Once you've logged out, say so.",
			"Then telinit 0.",
		];
		expect(passed.filter((text) => mayAsk(text))).toEqual([]);
		expect(lookedAt.filter((text) => !mayAsk(text))).toEqual([]);
	});

	it("looks closer at a power-off or shutdown with words between", () => {
		const lookedAt = [
			"Please power equilibrius off.",
			"Power optimus down when the run ends.",
			"Shut both of them down.",
		];
		expect(lookedAt.filter((text) => !mayAsk(text))).toEqual([]);
		expect(acts("Please power equilibrius off.")).toEqual(["shut down"]);
	});
});

describe("an ask said as a hedge or a suggestion", () => {
	it.each([
		["You might want to reboot optimus.", "reboot"],
		["You may need to log out of macOS on equilibrius.", "log out"],
		["You might need to reboot optimus.", "reboot"],
		["Can we restart equilibrius tonight?", "restart"],
		["Could we reboot optimus after the run?", "reboot"],
		["We should reboot optimus once it lands.", "reboot"],
		["So we should reboot optimus.", "reboot"],
		["There's no rush but please reboot optimus.", "reboot"],
		["If that doesn't work you'll need to reboot optimus.", "reboot"],
		["If that doesn't help please reboot optimus.", "reboot"],
		["If that doesn't work you may need to reboot optimus.", "reboot"],
		["Don't hesitate to reboot optimus if the mic stays dead.", "reboot"],
		["You could reboot optimus to pick up the kernel.", "reboot"],
		["Wait for the backup to finish and then reboot optimus.", "reboot"],
		["Stop the dev server and reboot optimus.", "reboot"],
		["No need to reboot, just log out and back in.", "log out"],
		["Instead of rebooting, log out of macOS on equilibrius.", "log out"],
		["Don't reboot, just log out.", "log out"],
		["If you'd rather not reboot, log out and back in.", "log out"],
		["Log out without rebooting, then pair the card.", "log out"],
		[
			"Reboot optimus instead of logging out, since the keyring needs it.",
			"reboot",
		],
		["Don't reboot optimus, just log out.", "log out"],
		["No need to reboot equilibrius, just log out.", "log out"],
		["The kernel's in, so we should reboot optimus.", "reboot"],
		["Feel free to reboot optimus tonight.", "reboot"],
		["Let me know once you log out of macOS on equilibrius.", "log out"],
		["Once you log out, pair the card at the login window.", "log out"],
		["When you reboot optimus, check the mic.", "reboot"],
		["Once you log out, open settings and pair the card.", "log out"],
		["Once you log out, don't forget to pair the card.", "log out"],
		["Once you log out, let's pair the card.", "log out"],
		["Once you log out, you can pair the card.", "log out"],
		["Once you log out, you'll need to re-pair the card.", "log out"],
		["Once you reboot, you'd have to pair the card.", "reboot"],
		["Once you log out and back in, the docker group applies.", "log out"],
		["Once you log out, hold this key.", "log out"],
		["When you reboot, update packages.", "reboot"],
	])("%s asks", (text, act) => {
		expect(acts(text)).toEqual([act]);
	});

	it.each([
		"If you reboot, five sessions end.",
		"When you reboot, they'll all end.",
		"When you reboot, niri restores the windows.",
		"When you log out, pi's sessions end.",
		"Until we can reboot optimus, the kernel waits.",
		"When you reboot, niri restarts.",
		"When you reboot, niri restores windows.",
		"When you reboot, niri picks them up again.",
		"When you log out, pi resumes where it was.",
		"When you log out, pi exits.",
		"When you reboot, pi won't come back.",
		"When you log out, you might lose unsaved windows.",
		"When you reboot, niri and waybar restart.",
	])("%s only says what would follow one", (text) => {
		expect(acts(text)).toEqual([]);
	});
});

describe("an ask closed off by a dash", () => {
	it.each([
		["If the mic is still dead \u2014 reboot optimus.", "reboot"],
		["Last thing \u2014 log out of macOS on equilibrius.", "log out"],
		["Then - reboot optimus.", "reboot"],
	])("%s asks", (text, act) => {
		expect(acts(text)).toEqual([act]);
	});
});

describe("a heading or a task box", () => {
	it("reads a heading that names a machine as the step it is", () => {
		expect(acts("### 2. Reboot optimus\n\nThe card pairs after.")).toEqual([
			"reboot",
		]);
	});

	it("reads a ticked box as done", () => {
		expect(acts("- [x] Reboot optimus\n- [ ] Pair the card")).toEqual([]);
	});
});

describe("a machine named only beside the act", () => {
	it("checks every machine when the act's own is unnamed", () => {
		expect(
			named("Once the run on optimus finishes, restart the MacBook."),
		).toEqual([[]]);
	});
});

describe("a label of the fifth round's shapes", () => {
	it("reads a head of the act and a time as the act", () => {
		expect(acts("Reboot now: the new kernel only loads at boot.")).toEqual([
			"reboot",
		]);
	});

	it.each([
		"Skip the reboot",
		"Don't reboot",
		"No restart tonight",
		"Postpone the reboot",
		"Hold off on the restart",
		"Without a reboot",
		"Don't reboot or log out",
		"No reboot and no log-out",
	])("%s asks nothing", (text) => {
		expect(asksInLabel(text, MACHINES)).toEqual([]);
	});

	it.each([
		["Cancel the backup and reboot equilibrius", "reboot"],
		["Don't forget to log out", "log out"],
		["No, reboot now", "reboot"],
		["Skip the backup, then restart", "restart"],
		["No \u2014 reboot now", "reboot"],
		["Skip the backup \u2014 reboot now", "reboot"],
		["Not now - reboot tonight", "reboot"],
		["Don't skip the reboot", "reboot"],
		["Don't delay the reboot", "reboot"],
		["Don't wait to reboot", "reboot"],
		["Never skip the reboot", "reboot"],
		["Don't reboot, just log out", "log out"],
		["No reboot \u2014 log out instead", "log out"],
		["Don't ever forget to log out", "log out"],
		["No skipping the reboot", "reboot"],
		["Cancel the backup to reboot now", "reboot"],
		["Don't hesitate to reboot equilibrius", "reboot"],
		["Postpone the reboot and log out now", "log out"],
		["Skip the reboot and log out instead", "log out"],
	])("%s still asks, since what it turns down isn't the act", (text, act) => {
		expect(asksInLabel(text, MACHINES).map((a) => a.act)).toEqual([act]);
	});

	it("asks nothing where the act qualifies a plural", () => {
		expect(acts("Fix the restart loops.")).toEqual([]);
		expect(asksInLabel("Clear reboot flags", MACHINES)).toEqual([]);
	});
});
