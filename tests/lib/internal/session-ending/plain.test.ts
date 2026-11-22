/**
 * A reply is plain when every command it shows is on the short list of
 * plain reboots, shut-downs and log-outs, and its prose holds none.
 */

import { describe, expect, it } from "vitest";
import {
	commandsNamedIn,
	notPlainIn,
	plainlySaid,
} from "../../../../lib/internal/session-ending/plain.ts";

describe("plainlySaid", () => {
	it.each([
		"Please reboot optimus.",
		"Shut down optimus once the update lands.",
		"Reboot with `sudo systemctl reboot`.",
		"Power it off: `systemctl poweroff`.",
		"Then `sudo shutdown -r now`.",
		"Log out with `loginctl terminate-session` or `niri msg action quit -s`.",
		"Reboot:\n\n```sh\n# as root\n$ sudo  reboot\n\n```",
		"The shutdown was clean, and a reboot follows.",
		"Reboot optimus to finish the software update.",
		"Reboot optimus - the update is staged.",
		"Reboot:\n\n```\n# reboot\n```",
		"Reboot:\n\n    sudo reboot\n",
		'Reboot optimus, then run "sudo reboot".',
		"Reboot optimus:\n$ sudo systemctl reboot",
	])("is plain: %s", (said) => {
		expect(plainlySaid([said]), said).toBe(true);
	});

	it.each([
		"Reboot with `sudo systemctl reboot --soft`.",
		"Reboot, or `sudo systemctl rescue`.",
		"Reboot with `sudo init 1`.",
		"Reboot; if it hangs, sudo kexec -e brings it back.",
		"Reboot, then systemctl --user exit.",
		"Reboot over ssh optimus.",
		"Soft-reboot optimus.",
		"Turn off linger, then log out.",
		"Set KillUserProcesses=yes and log out.",
		"Log out with `loginctl disable-linger joel; loginctl terminate-session`.",
		"Reboot:\n\n```sh\nsudo systemctl isolate rescue.target\n```",
		"Reboot:\n\n```console\n$ sudo reboot\n$ kexec -e\n```",
		"Reboot:\n\n```yaml\nboot: rescue\n```",
		"Reboot:\n\n```\n# kexec -e\n```",
		"Reboot:\n\n```console\n# kexec -e\n```",
		"Reboot:\n\n```text\n# kexec -e\n```",
		"Log out, then kill $(pgrep -u joel).",
		"Reboot optimus. Then:\n\n    kill 1234\n",
		'Reboot optimus, then run "kill 1234".',
		"Copy the tree into /run/nextroot, then reboot.",
		"Reboot optimus. If it hangs, ``reboot`sudo kexec -e`.",
		"Reboot optimus: `` `sudo kexec -e`",
		"Log out of niri on optimus with `loginctl terminate-session -Hequilibrius`.",
		"Log out of niri on optimus, then skill -KILL -u joel.",
		"Reboot optimus, then:\n$ echo b > /proc/sysrq-trigger",
		"Reboot with `sudo systemctl reboot -i`.",
		"Reboot with `sudo reboot -f`.",
		"Then `shutdown -r now +5`.",
		"Log out with `loginctl terminate-session 3 4`.",
		"Log out with `niri msg action quit -s now`.",
		"Please reboot optimus with:\n```sudo kexec -e```",
		"Please reboot optimus:\n\n> ~~~\n> # bootctl set-oneshot rescue.conf\n> # reboot\n> ~~~",
		"Reboot:\n\n1. ~~~\n   # bootctl set-oneshot rescue.conf\n   ~~~",
		"Please reboot optimus:\n\n```sh\nsudo reboot\n    ```\n# bootctl set-oneshot rescue.conf\n```",
		"Reboot optimus:\n\n>     bootctl set-oneshot rescue",
		"Reboot optimus. If it hangs, ``reboot`bootctl set-oneshot rescue`.",
		"Reboot optimus. Then:\n\n    bootctl set-oneshot rescue\n",
		'Reboot optimus, then run "bootctl set-oneshot rescue".',
		"Reboot optimus: run `systemctl reboot`. For rescue, systemctl reboot --boot-loader-entry=rescue.conf.",
		"Reboot optimus: run `sudo reboot`, or if it hangs, sudo reboot -f.",
		'Reboot optimus: run "sudo reboot", or if it hangs, sudo reboot -f.',
		"Please reboot optimus:\n\n```md\necho b > /proc/sysrq-trigger\n```",
		"Please reboot optimus:\n\n```markdown\nbootctl set-oneshot rescue.conf\n```",
		"Please reboot optimus:\n\n```sh\nsudo reboot\n# if it hangs, run: sudo kexec -e\n```",
		"Please reboot optimus:\n\n```bash\n# then `bootctl set-oneshot rescue`\nsudo reboot\n```",
	])("is not plain: %s", (said) => {
		expect(plainlySaid([said]), said).toBe(false);
	});

	it.each([
		["Reboot, or `sudo systemctl rescue`.", "sudo systemctl rescue"],
		["Soft-reboot optimus.", "Soft"],
		["Reboot:\n\n```sh\nsudo reboot\nkexec -e\n```", "kexec -e"],
		["Reboot optimus. If it hangs, ``reboot`x`.", "an unpaired backtick"],
		["Reboot:\n\n```sh\nsudo reboot\n# or kexec -e\n```", "kexec"],
	])("names what isn't plain: %s", (said, what) => {
		expect(notPlainIn([said])).toBe(what);
	});

	it("names nothing where all is plain", () => {
		expect(notPlainIn(["Please reboot optimus."])).toBeUndefined();
	});

	it("reads every text it is given, a label as much as prose", () => {
		expect(
			plainlySaid(["Reboot optimus", "`sudo systemctl soft-reboot`"]),
			"the code in the second text counts",
		).toBe(false);
	});
});

describe("commandsNamedIn", () => {
	it.each([
		[
			"Done. If it hangs, run `sudo systemctl isolate rescue.target`.",
			"sudo systemctl isolate rescue.target",
		],
		["Copy the tree into /run/nextroot first.", "nextroot"],
		["The notes are in `notes.md`, and `kexec -e` brings it back.", "kexec -e"],
		["Notes:\n\n```sh\ncat notes.md\nsudo kexec -e\n```", "sudo kexec -e"],
		["See `notes.md`. If it hangs, sudo kexec -e.", "sudo"],
		["Then:\n\n```sh\nls\n# or kill it\n```", "kill"],
		["If that fails, shutdown -hP now.", "shutdown -hP"],
		["Run `tmux kill-server` after.", "tmux kill-server"],
	])("names the command in: %s", (said, what) => {
		expect(commandsNamedIn([said])[0]).toBe(what);
	});

	it.each([
		"Done; the notes are in `notes.md`.",
		"The reboot went fine, and `journalctl -b` is clean.",
		"It runs `sudo reboot` once you say.",
		"The log:\n\n```text\nboot.log\n```",
		"Reboot optimus. If it hangs, ``reboot`x`.",
		"The skills are loaded, and the stuck test was killed.",
		"See `~/.pi/skills/README.md` and `/etc/sudoers.d/joel`; sshd is up.",
	])("names nothing in: %s", (said) => {
		expect(commandsNamedIn([said])).toEqual([]);
	});

	it("reads every text it is given", () => {
		expect(commandsNamedIn(["All done.", "`loginctl enable-linger`"])).toEqual([
			"loginctl enable-linger",
		]);
	});

	it("names every command, in the order they are met", () => {
		expect(
			commandsNamedIn([
				"See `ls skills`, then `sudo kexec -e`; the skills say killall pi.",
			]),
		).toEqual(["sudo kexec -e", "killall"]);
	});
});
