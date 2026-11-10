/**
 * The clipboard widget's wiring: Ctrl+V in pi's editor under Wayland
 * pastes through its shell, never forking the session itself, and the
 * key is left to pi wherever the editor doesn't hold it.
 */

import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import clipboardWidget from "../../../extensions/clipboard-widget/index.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { until } from "../../support/until.ts";

type Listener = (data: string) => { consume?: boolean } | undefined;
type Factory = (tui: unknown) => { render: (width: number) => string[] };

let scratch: string;
let parents: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "clipboard-widget-"));
	parents = join(scratch, "parents");
	const wlPaste = join(scratch, "wl-paste");
	writeFileSync(
		wlPaste,
		[
			"#!/bin/sh",
			`echo "$PPID" >> '${parents}'`,
			'case "$1" in',
			"  --list-types) printf 'text/plain\\nUTF8_STRING\\n' ;;",
			"  --no-newline) printf 'pasted words' ;;",
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(wlPaste, 0o755);
	vi.stubEnv("PATH", `${scratch}${delimiter}${process.env.PATH ?? ""}`);
	vi.stubEnv("WAYLAND_DISPLAY", "wayland-test");
	vi.stubEnv("TERMUX_VERSION", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(scratch, { recursive: true, force: true });
});

/** pi's editor as the widget meets it: text, a cursor, and an insert. */
function editor() {
	const inserted: string[] = [];
	return {
		inserted,
		render: () => [],
		invalidate: () => {},
		handleInput: () => {},
		getText: () => "",
		setText: () => {},
		getCursor: () => ({ line: 0, col: 0 }),
		insertTextAtCursor: (text: string) => inserted.push(text),
	};
}

async function started(focused: unknown) {
	const pi = fakePi();
	clipboardWidget(pi);
	const listeners: Listener[] = [];
	const widgets: { placement?: string; drawn: string[] }[] = [];
	let renders = 0;
	const tui = {
		getFocusedComponent: () => focused,
		requestRender: () => {
			renders += 1;
		},
	};
	const ctx = {
		hasUI: true,
		ui: {
			onTerminalInput: (listener: Listener) => {
				listeners.push(listener);
				return () => listeners.splice(listeners.indexOf(listener), 1);
			},
			setWidget: (
				_key: string,
				factory: Factory,
				options?: { placement?: string },
			) =>
				widgets.push({
					placement: options?.placement,
					drawn: factory(tui).render(80),
				}),
			notify: () => {},
		},
	};
	const fire = async (event: string) => {
		for (const handler of pi.recorded.handlers.get(event) ?? []) {
			await handler({ type: event }, ctx);
		}
	};
	await fire("session_start");
	const press = (data: string) => listeners.map((listener) => listener(data));
	return { press, widgets, fire, listeners, renders: () => renders };
}

describe("the clipboard widget", () => {
	it("pastes in the editor through its shell, never forking the session", async () => {
		const target = editor();
		const { press, widgets, fire, renders } = await started(target);
		const answers = press("\u0016");
		await until("the paste lands", () => target.inserted.length > 0);
		await fire("session_shutdown");
		const forkedBy = readFileSync(parents, "utf8").trim().split("\n");
		expect({
			answers,
			inserted: target.inserted,
			widgets,
			rendered: renders() > 0,
			bySession: forkedBy.filter((pid) => pid === String(process.pid)),
			reads: forkedBy.length,
		}).toEqual({
			answers: [{ consume: true }],
			inserted: ["pasted words"],
			widgets: [{ placement: "belowEditor", drawn: [] }],
			rendered: true,
			bySession: [],
			reads: 2,
		});
	});

	it("leaves Ctrl+V to pi when something other than the editor holds the keys", async () => {
		const { press } = await started({ render: () => [], invalidate: () => {} });
		expect(press("\u0016")).toEqual([undefined]);
	});

	it("leaves every other key alone", async () => {
		const { press } = await started(editor());
		expect(press("v")).toEqual([undefined]);
	});

	it("stops listening when the session ends", async () => {
		const { fire, listeners } = await started(editor());
		await fire("session_shutdown");
		expect(listeners).toEqual([]);
	});

	it("takes nothing without a Wayland display", async () => {
		vi.stubEnv("WAYLAND_DISPLAY", undefined);
		const pi = fakePi();
		clipboardWidget(pi);
		expect([...pi.recorded.handlers.keys()]).toEqual([]);
	});
});
