/**
 * A pi started afresh on a session an earlier process wrote says which
 * harness code it runs when the session's last word on it no longer
 * holds. On 13 November a parked session woken at 19:06 ran the install
 * of 18:37 while its log's last note named the code of 17:26, and its
 * model went by the note.
 */

import type {
	CustomMessageEntry,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { outdatedNoteSaid } from "../../../extensions/reload-workflow/lifecycle.ts";
import { LOADED_MESSAGE } from "../../../lib/internal/reload/loaded.ts";

const NOW =
	"agentic-harness.pi runs its install, ~/.local/share/pi-packages/versions/16c71561 at 16c71561.";
const BEFORE =
	"Reloaded between runs, because the install moved: it moved. agentic-harness.pi runs its install, ~/.local/share/pi-packages/versions/233d61cf at 233d61cf.";

let ids = 0;

/** A note on which code runs, as the reload workflow leaves one. */
function note(content: CustomMessageEntry["content"]): SessionEntry {
	ids += 1;
	const entry: CustomMessageEntry = {
		type: "custom_message",
		id: `e${ids}`,
		parentId: null,
		timestamp: "2026-11-13T22:26:33.000Z",
		customType: LOADED_MESSAGE,
		content,
		display: false,
	};
	return entry;
}

describe("a fresh start's word on which harness code runs", () => {
	it("says what runs when the last note names other code", () => {
		const said = outdatedNoteSaid([note(BEFORE)], NOW);
		expect(said, "a stale note was left standing").toContain(NOW);
		expect(
			said,
			"the note didn't say the earlier ones are out of date",
		).toMatch(/out of date/);
	});

	it("reads a note written as text parts", () => {
		const said = outdatedNoteSaid(
			[note([{ type: "text", text: BEFORE }])],
			NOW,
		);
		expect(said, "a note in parts was missed").toContain(NOW);
	});

	it("goes by the last note only", () => {
		const said = outdatedNoteSaid([note(BEFORE), note(`Loaded. ${NOW}`)], NOW);
		expect(said, "a note that still holds was said again").toBeUndefined();
	});

	it("says nothing where no note was ever left", () => {
		expect(
			outdatedNoteSaid([], NOW),
			"a session with no note was told one",
		).toBeUndefined();
	});
});
