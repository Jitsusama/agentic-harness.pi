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
			for (const key of [
				"SSH_CONNECTION",
				"SSH_CLIENT",
				"MOSH_CONNECTION",
				"PI_CLIPBOARD_OSC52",
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
			process.env.MYCELIUM_HELD = "h1";
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
			expect(written).toContain(sequence);
		},
	);
});
