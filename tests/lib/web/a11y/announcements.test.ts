import { describe, expect, it } from "vitest";
import {
	type Announcement,
	renderAnnouncements,
} from "../../../../lib/web/a11y/index.js";
import type { Recorded } from "../../../../lib/web/telemetry/index.js";

function heard(
	...items: Array<[Announcement["politeness"], string]>
): Recorded<Announcement>[] {
	return items.map(([politeness, text], index) => ({
		seq: index + 1,
		item: { politeness, text, at: 1000 + index },
	}));
}

describe("renderAnnouncements", () => {
	it("lists what was said, in the order it was said", () => {
		const rendered = renderAnnouncements(
			heard(["polite", "Saved successfully"], ["assertive", "Network error"]),
		);
		expect(rendered).toBe(
			["polite: Saved successfully", "assertive: Network error"].join("\n"),
		);
	});

	it("says plainly when nothing was announced", () => {
		// Silence is a finding: a control that changes the page
		// without telling anyone is the bug being looked for.
		expect(renderAnnouncements([])).toBe("Nothing was announced.");
	});

	it("admits when it had to drop older announcements", () => {
		const rendered = renderAnnouncements(heard(["polite", "Latest"]), 3);
		expect(rendered).toBe(
			["polite: Latest", "", "3 earlier announcements were dropped."].join(
				"\n",
			),
		);
	});

	it("says nothing about dropping when nothing was dropped", () => {
		expect(renderAnnouncements(heard(["polite", "One"]), 0)).toBe(
			"polite: One",
		);
	});

	it("keeps an announcement that spans several lines readable", () => {
		const rendered = renderAnnouncements(
			heard(["polite", "Line one\nLine two"]),
		);
		expect(rendered).toBe("polite: Line one Line two");
	});
});
