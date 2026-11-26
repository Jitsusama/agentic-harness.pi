/**
 * A held pi sends its copies to the terminal showing it as OSC 52, so a
 * session held on one machine and attached from another copies into the
 * person's clipboard; an unheld pi copies as pi does.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyThroughHeldTerminal } from "../../../../lib/internal/clipboard/through-terminal.ts";

const SAVED = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in SAVED)) delete process.env[key];
	}
	Object.assign(process.env, SAVED);
	vi.restoreAllMocks();
});

describe("copyThroughHeldTerminal", () => {
	it("turns OSC 52 on for a held pi", () => {
		const env: Record<string, string | undefined> = { MYCELIUM_HELD: "h1" };
		copyThroughHeldTerminal(env);
		expect(env.PI_CLIPBOARD_OSC52).toBe("1");
	});

	it("leaves an unheld pi as pi has it", () => {
		const env: Record<string, string | undefined> = {};
		copyThroughHeldTerminal(env);
		expect(env.PI_CLIPBOARD_OSC52).toBeUndefined();
	});

	it("keeps a value the person set", () => {
		const env: Record<string, string | undefined> = {
			MYCELIUM_HELD: "h1",
			PI_CLIPBOARD_OSC52: "0",
		};
		copyThroughHeldTerminal(env);
		expect(env.PI_CLIPBOARD_OSC52).toBe("0");
	});

	// The local clipboard faked here is Wayland's, which only Linux asks.
	it.skipIf(process.platform !== "linux")(
		"makes pi's own copy send OSC 52 in a held pi with no SSH markers",
		async () => {
			expect(
				await copiedAsOsc52("h1"),
				"the value is copied through the terminal",
			).toBe(true);
		},
	);

	it.skipIf(process.platform !== "linux")(
		"leaves pi's own copy local in the same pi when it is not held",
		async () => {
			expect(
				await copiedAsOsc52(undefined),
				"nothing is copied without a value",
			).toBe(false);
		},
	);
});

/**
 * Copies a line through pi's own copy, on a machine with a local
 * clipboard and no SSH markers, held or not, and says whether pi also
 * wrote it to the terminal as OSC 52.
 */
async function copiedAsOsc52(held: string | undefined): Promise<boolean> {
	for (const key of [
		"SSH_CONNECTION",
		"SSH_CLIENT",
		"MOSH_CONNECTION",
		"PI_CLIPBOARD_OSC52",
		"MYCELIUM_HELD",
		"DISPLAY",
		"TERMUX_VERSION",
	]) {
		delete process.env[key];
	}
	// A local clipboard that takes the copy, as the machine pi runs on
	// has, so only the held switch can make pi send OSC 52 as well.
	const bin = mkdtempSync(join(tmpdir(), "through-terminal-"));
	const wlCopy = join(bin, "wl-copy");
	writeFileSync(wlCopy, "#!/bin/sh\ncat > /dev/null\n");
	chmodSync(wlCopy, 0o755);
	process.env.PATH = `${bin}:/usr/bin:/bin:${SAVED.PATH ?? ""}`;
	process.env.WAYLAND_DISPLAY = "wayland-test";
	if (held !== undefined) process.env.MYCELIUM_HELD = held;
	const written: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		written.push(String(chunk));
		return true;
	});

	copyThroughHeldTerminal(process.env);
	try {
		await copyToClipboard("copied line");
	} finally {
		rmSync(bin, { recursive: true, force: true });
	}

	const sequence = `\x1b]52;c;${Buffer.from("copied line").toString("base64")}\x07`;
	return written.includes(sequence);
}
