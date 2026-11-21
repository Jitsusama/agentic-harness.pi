/**
 * A reply is plain when every command it shows is on the short list of
 * plain reboots, shut-downs and log-outs, and its prose holds none.
 */

import { describe, expect, it } from "vitest";
import { plainlySaid } from "../../../../lib/internal/session-ending/plain.ts";

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
	])("is not plain: %s", (said) => {
		expect(plainlySaid([said]), said).toBe(false);
	});

	it("reads every text it is given, a label as much as prose", () => {
		expect(
			plainlySaid(["Reboot optimus", "`sudo systemctl soft-reboot`"]),
			"the code in the second text counts",
		).toBe(false);
	});
});
