import { describe, expect, it } from "vitest";
import { OUTCOME_GLYPH } from "../../../lib/ui/index.ts";
import { drawn } from "./drawn.ts";

/**
 * How the Slack tool draws a send that did not happen.
 *
 * A cancel is somebody saying no, which neither passed nor failed, so it
 * is drawn dim; a failure is drawn as one. Both used to share a ballot x
 * and the warning colour, so a send that broke halfway through a thread
 * looked like a send somebody declined.
 */

describe("how a Slack send that did not happen is drawn", () => {
	it("draws a cancel dim, with the mark for one", () => {
		const shown = drawn(`${OUTCOME_GLYPH.cancelled} Send message cancelled.`);

		expect(shown).toContain(`<dim>${OUTCOME_GLYPH.cancelled} Send message`);
	});

	it("draws a failure as an error, with the mark for one", () => {
		const shown = drawn(
			`${OUTCOME_GLYPH.failed} Thread failed at message 2 of 3: rate limited.`,
		);

		expect(shown).toContain(`<error>${OUTCOME_GLYPH.failed} Thread failed`);
	});
});
