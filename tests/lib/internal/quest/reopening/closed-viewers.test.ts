import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetRecord } from "../../../../../extensions/quest-workflow/sessions/records.ts";
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
		expect(viewerWasClosed("01a1eeee-ffff"), "the closed window is kept").toBe(
			true,
		);
		expect(viewerWasClosed("01a1cccc-dddd"), "only its own").toBe(false);
		await keepViewerClosed("01a1eeee-ffff", false);
		expect(
			viewerWasClosed("01a1eeee-ffff"),
			"the window viewed again is no longer kept",
		).toBe(false);
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
		expect(
			viewerWasClosed("01a1eeee-ffff"),
			"the last said, closed, is kept",
		).toBe(true);
		await Promise.all(
			[true, false].map((closed) => keepViewerClosed("01a1eeee-ffff", closed)),
		);
		expect(
			viewerWasClosed("01a1eeee-ffff"),
			"the last said, viewed, is not kept",
		).toBe(false);
	});

	it("writes nothing for an id that isn't a file name alone", async () => {
		await keepViewerClosed("../escape", true);
		expect(
			viewerWasClosed("../escape"),
			"an id with a path is never kept",
		).toBe(false);
		expect(
			viewerWasClosed("escape"),
			"a refused path leaves no mark under its last part",
		).toBe(false);
		for (const folder of [".", ".."]) {
			await keepViewerClosed(folder, true);
			expect(viewerWasClosed(folder), `${folder} names a folder`).toBe(false);
		}
		expect(viewerWasClosed("01a1.eeee"), "a dot inside is a name").toBe(false);
		await keepViewerClosed("01a1.eeee", true);
		expect(viewerWasClosed("01a1.eeee"), "an id with a dot alone is kept").toBe(
			true,
		);
	});

	it("says why it couldn't be kept, and the next is still kept", async () => {
		const dir = closedViewersDir();
		mkdirSync(dirname(dir), { recursive: true });
		writeFileSync(dir, "a file where a folder goes");
		// Both are said before the first fails, so the second waits on a write that rejects.
		const failing = keepViewerClosed("01a1eeee-ffff", true);
		const next = keepViewerClosed("01a1eeee-ffff", false);
		await expect(failing).rejects.toThrow();
		await expect(next, "a clear needs no folder").resolves.toBeUndefined();
		rmSync(dir);
		await keepViewerClosed("01a1eeee-ffff", true);
		expect(viewerWasClosed("01a1eeee-ffff"), "the next is still kept").toBe(
			true,
		);
	});

	it("goes with its record", async () => {
		await keepViewerClosed("01a1eeee-ffff", true);
		forgetRecord("01a1eeee-ffff");
		expect(viewerWasClosed("01a1eeee-ffff"), "forgetting the record").toBe(
			false,
		);
		await keepViewerClosed("01a1eeee-ffff", true);
		forgetClosedViewer("01a1eeee-ffff");
		expect(viewerWasClosed("01a1eeee-ffff"), "it goes with its record").toBe(
			false,
		);
		forgetClosedViewer("01a1eeee-ffff");
		expect(
			closedViewersDir().startsWith(state),
			`the folder is under the state: ${closedViewersDir()}`,
		).toBe(true);
	});
});
