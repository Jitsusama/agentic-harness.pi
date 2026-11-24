import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closedViewersDir,
	forgetClosedViewer,
	keepViewerClosed,
	viewerWasClosed,
} from "../../../../../lib/internal/quest/reopening/closed-viewers.ts";

let state: string;
beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "closed-viewers-"));
	vi.stubEnv("XDG_STATE_HOME", state);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(state, { recursive: true, force: true });
});

describe("a closed viewer's mark", () => {
	it("is kept once the window is closed, and taken away once one views it again", async () => {
		expect(viewerWasClosed("01a1eeee-ffff"), "nothing closed yet").toBe(false);
		await keepViewerClosed("01a1eeee-ffff", true);
		expect(viewerWasClosed("01a1eeee-ffff")).toBe(true);
		expect(viewerWasClosed("01a1cccc-dddd"), "only its own").toBe(false);
		await keepViewerClosed("01a1eeee-ffff", false);
		expect(viewerWasClosed("01a1eeee-ffff")).toBe(false);
		await keepViewerClosed("01a1eeee-ffff", false);
		expect(viewerWasClosed("01a1eeee-ffff"), "clearing none is nothing").toBe(
			false,
		);
	});

	it("ends as it was last said, whatever order its writes finish in", async () => {
		const said = [true, false, true, false, true].map((closed) =>
			keepViewerClosed("01a1eeee-ffff", closed),
		);
		await Promise.all(said);
		expect(viewerWasClosed("01a1eeee-ffff")).toBe(true);
		await Promise.all(
			[true, false].map((closed) => keepViewerClosed("01a1eeee-ffff", closed)),
		);
		expect(viewerWasClosed("01a1eeee-ffff")).toBe(false);
	});

	it("writes nothing for an id that isn't a file name alone", async () => {
		await keepViewerClosed("../escape", true);
		expect(viewerWasClosed("../escape")).toBe(false);
		expect(viewerWasClosed("escape")).toBe(false);
	});

	it("says why it couldn't be kept, and the next is still kept", async () => {
		writeFileSync(join(state, "quest-workflow"), "a file where a folder goes");
		await expect(keepViewerClosed("01a1eeee-ffff", true)).rejects.toThrow();
		rmSync(join(state, "quest-workflow"));
		await keepViewerClosed("01a1eeee-ffff", true);
		expect(viewerWasClosed("01a1eeee-ffff")).toBe(true);
	});

	it("goes with its record", async () => {
		await keepViewerClosed("01a1eeee-ffff", true);
		forgetClosedViewer("01a1eeee-ffff");
		expect(viewerWasClosed("01a1eeee-ffff")).toBe(false);
		forgetClosedViewer("01a1eeee-ffff");
		expect(closedViewersDir().startsWith(state)).toBe(true);
	});
});
