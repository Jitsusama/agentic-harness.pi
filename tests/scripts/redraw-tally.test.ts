import { describe, expect, it } from "vitest";
import { formatRedraws, tallyRedraws } from "../../scripts/redraw-tally.ts";

// Lines as pi-tui 1.5.0 writes them (tui-main-screen.js, logRedraw).
const LOG = [
	"[2026-11-12T07:00:00.000Z] fullRender: first render (prev=0, new=12, height=40)",
	"[2026-11-12T07:01:00.000Z] fullRender: firstChanged < viewportTop (3 < 9) (prev=50, new=52, height=40)",
	"[2026-11-12T07:02:00.000Z] fullRender: terminal width changed (120 -> 80) (prev=52, new=60, height=40)",
	"[2026-11-12T07:03:00.000Z] fullRender: firstChanged < viewportTop (5 < 12) (prev=60, new=61, height=40)",
	"not a redraw",
	"",
	"[2026-11-12T07:04:00.000Z] fullRender: clearOnShrink (maxLinesRendered=70) (prev=61, new=30, height=40)",
].join("\n");

// Joel, 11 November: "text from ask dialogs disappeearing as text comes
// in". Counting first says which redraw the fix must stop.
describe("why pi redrew the whole screen", () => {
	it("counts each reason by its words, most first, whatever numbers it carried", () => {
		const tally = tallyRedraws(LOG);

		expect(tally.redraws, "every redraw line").toBe(5);
		expect(tally.unread, "the line that wasn't one").toBe(1);
		expect(
			tally.kinds.map((kind) => [kind.reason, kind.count]),
			"by kind, most first",
		).toEqual([
			["firstChanged < viewportTop", 2],
			["clearOnShrink", 1],
			["first render", 1],
			["terminal width changed", 1],
		]);
		expect(
			tally.kinds[0],
			"when the commonest came first and last",
		).toMatchObject({
			first: "2026-11-12T07:01:00.000Z",
			last: "2026-11-12T07:03:00.000Z",
		});
	});

	it("counts only from the time it's given", () => {
		const tally = tallyRedraws(LOG, "2026-11-12T07:02:30.000Z");
		expect(
			tally.kinds.map((kind) => kind.reason),
			"the two after it",
		).toEqual(["clearOnShrink", "firstChanged < viewportTop"]);
	});

	it("says each kind's share, and asks after the setting when there are none", () => {
		expect(formatRedraws(tallyRedraws(LOG), "log"), "a share each").toContain(
			"2   40%  firstChanged < viewportTop  (last 2026-11-12T07:03:00.000Z)",
		);
		expect(formatRedraws(tallyRedraws(""), "log"), "none yet").toContain(
			"PI_TUI_DEBUG_REDRAW=1",
		);
	});
});
