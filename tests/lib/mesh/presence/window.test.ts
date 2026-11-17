/**
 * How the desktop finds a peer's window: its title as pi composes it,
 * and the terminal window it names.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPeer } from "../../../../lib/mesh/peer.ts";
import { createPresences, windowTitle } from "../../../../lib/mesh/presence.ts";
import { session, surroundingsAt } from "./support/presences.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-presence-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("a window's title", () => {
	// windowTitle copies how pi titles its terminal, which pi does not
	// export. Read pi's own source, so a pi upgrade that changes the shape
	// fails here rather than leaving the desktop matching no window.
	const pi = dirname(
		fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
	);
	const source = (path: string) => readFileSync(join(pi, path), "utf8");

	it("is composed as pi composes it, with and without a session name", () => {
		const interactive = source("modes/interactive/interactive-mode.js");
		expect(interactive).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source text under test.
			"setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`)",
		);
		expect(interactive).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source text under test.
			"setTitle(`${APP_TITLE} - ${cwdBasename}`)",
		);
		expect(source("config.js")).toContain(
			'APP_TITLE = piConfigName ? APP_NAME : "\u03c0"',
		);

		expect(windowTitle("Agentic loop", "/home/someone/src/core.nix")).toBe(
			"\u03c0 - Agentic loop - core.nix",
		);
		expect(windowTitle(undefined, "/home/someone/src/core.nix")).toBe(
			"\u03c0 - core.nix",
		);
	});
});

describe("this session's peer", () => {
	const surroundings = () => surroundingsAt(root);

	it("says its window's title as pi sets it, and the new one after a rename", () => {
		// The desktop finds a peer's window by this exact title, since the
		// title itself no longer carries an address.
		let name: string | undefined;
		const at = {
			...surroundings(),
			title: () => windowTitle(name, "/home/someone/src/core.nix"),
		};
		const peer = localPeer(at);
		expect(at.presences.of(session)?.title).toBe("\u03c0 - core.nix");

		name = "Agentic loop";
		peer.setBusy(true);

		expect(at.presences.of(session)?.title).toBe(
			"\u03c0 - Agentic loop - core.nix",
		);
		expect(createPresences(join(root, "presence")).of(session)?.title).toBe(
			"\u03c0 - Agentic loop - core.nix",
		);
	});

	it("names the terminal window it runs in, as read back from its file", () => {
		// The desktop raises a peer's window by this, since titles can be
		// cut, shared or overridden.
		const terminal = {
			driverId: "kitty",
			kind: "kitty-window",
			hostId: "optimus",
			value: "8",
			scope: "unix:@kitty-318380",
		};
		localPeer({ ...surroundings(), terminal });

		expect(
			createPresences(join(root, "presence")).of(session)?.terminal,
		).toEqual(terminal);
	});
});
