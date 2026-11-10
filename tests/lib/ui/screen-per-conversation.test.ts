/**
 * A host holds a screen for each conversation, so what one screen shares
 * (its gate queue, open panels, panel height and dock) is that
 * conversation's alone, while plain pi keeps the one process-wide key
 * every copy of the library already joins.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	NoSessionInHost,
	withSession,
} from "../../../lib/core/session/index.ts";
import {
	lastKeyAt,
	noteReplacing,
	replacing,
	watchKeys,
} from "../../../lib/ui/dock.ts";
import { runGate } from "../../../lib/ui/gate-queue.ts";
import {
	getPanelHeightMode,
	setPanelHeightMode,
} from "../../../lib/ui/panel-height.ts";
import { closeEveryPanel, trackPanel } from "../../../lib/ui/panel-registry.ts";
import { installTestHost } from "../../support/session-host.ts";

let host: ReturnType<typeof installTestHost> | undefined;

afterEach(() => {
	host?.dispose();
	host = undefined;
	setPanelHeightMode("normal");
	noteReplacing(false);
});

/** Let every settled promise run its handlers. */
async function drain(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A terminal context whose input reaches the returned `send`. */
function watched() {
	let listener: ((data: string) => unknown) | undefined;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			onTerminalInput: (handler: (data: string) => unknown) => {
				listener = handler;
				return () => {
					listener = undefined;
				};
			},
		},
	} as unknown as ExtensionContext;
	const stop = watchKeys(ctx);
	return { send: (data: string) => listener?.(data), stop };
}

describe("a screen on plain pi", () => {
	it("keeps its height under the key every copy joins", () => {
		setPanelHeightMode("fullscreen");
		expect(
			Reflect.get(globalThis, Symbol.for("pi:panelHeightMode")),
			"the height sits where an older copy reads it",
		).toBe("fullscreen");
		expect(getPanelHeightMode()).toBe("fullscreen");
	});
});

describe("a host's screens", () => {
	it("give each conversation its own gate queue", async () => {
		host = installTestHost();
		let release: () => void = () => undefined;
		const held = withSession("a", () =>
			runGate(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			),
		);
		let bRan = false;
		const b = withSession("b", () =>
			runGate(async () => {
				bRan = true;
			}),
		);
		await drain();
		expect(bRan, "b's gate mounts while a's is still up").toBe(true);
		await b;
		release();
		await held;
	});

	it("close only the ending conversation's panels", () => {
		host = installTestHost();
		const stopped: string[] = [];
		withSession("a", () => trackPanel(() => stopped.push("a")));
		withSession("b", () => trackPanel(() => stopped.push("b")));
		expect(withSession("a", () => closeEveryPanel())).toBe(1);
		expect(stopped, "b's waiting approval stays up").toEqual(["a"]);
		expect(withSession("b", () => closeEveryPanel())).toBe(1);
		expect(stopped).toEqual(["a", "b"]);
	});

	it("size each conversation's panels by its own zoom", () => {
		host = installTestHost();
		withSession("a", () => setPanelHeightMode("fullscreen"));
		expect(withSession("a", () => getPanelHeightMode())).toBe("fullscreen");
		expect(withSession("b", () => getPanelHeightMode())).toBe("normal");
	});

	it("keep each conversation's typing and replace to its own dock", () => {
		host = installTestHost();
		const a = withSession("a", () => watched());
		withSession("a", () => a.send("x"));
		expect(
			withSession("a", () => lastKeyAt()),
			"a key typed in a counts in a",
		).toBeTypeOf("number");
		expect(
			withSession("b", () => lastKeyAt()),
			"and not in b",
		).toBeUndefined();
		withSession("b", () => noteReplacing(true));
		expect(
			withSession("a", () => replacing()),
			"a replacement in b leaves a's panels standing",
		).toBe(false);
		expect(
			withSession("b", () => replacing()),
			"b knows it is being replaced",
		).toBe(true);
		a.stop();
	});

	it("forget a conversation's screen when it closes", () => {
		host = installTestHost();
		withSession("a", () => setPanelHeightMode("minimized"));
		host.host.close("a", "test");
		expect(withSession("a", () => getPanelHeightMode())).toBe("normal");
	});

	it("refuse a call outside any conversation rather than share one", () => {
		host = installTestHost();
		expect(() => getPanelHeightMode()).toThrow(NoSessionInHost);
	});
});
