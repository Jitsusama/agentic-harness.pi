import type { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderGoogleCall } from "../../../extensions/google-workspace-integration/render-call";
import { renderGoogleResult } from "../../../extensions/google-workspace-integration/render-result";
import { fakeTheme } from "../../lib/ui/fake-theme";

const theme = fakeTheme();

/**
 * What a rendered component actually puts on screen.
 *
 * Read through `render` rather than off the component's own field,
 * which is private: a test that reaches inside is asserting on a
 * decision the component has not published, and this one does not
 * need to, since the whole question is what the user sees.
 */
function shown(component: Text): string {
	return component.render(WIDE_ENOUGH).join("\n");
}

/** Wide enough that nothing wraps for reasons of its own. */
const WIDE_ENOUGH = 400;

describe("rendering a Google call line", () => {
	it("names the action being taken", () => {
		const line = shown(renderGoogleCall({ action: "search_emails" }, theme));

		expect(line).toContain("google");
		expect(line).toContain("search_emails");
	});

	it("says which account when it is not the usual one", () => {
		const usual = shown(
			renderGoogleCall({ action: "get_email", account: "work" }, theme),
		);
		const other = shown(
			renderGoogleCall({ action: "get_email", account: "personal" }, theme),
		);

		// The default account is not labelled: a label on every line
		// stops being a signal that this one is different.
		expect(usual).not.toContain("work]");
		expect(other).toContain("[personal]");
	});

	it("shortens a subject too long to sit on one line", () => {
		const subject = "A subject line written at length".repeat(6);
		const line = shown(
			renderGoogleCall(
				{ action: "send_email", to: ["someone@example.com"], subject },
				theme,
			),
		);

		// Elided against an assumed terminal width, because pi hands a
		// renderer the theme and no width. The assertion is that what
		// comes out is shorter than what went in and says it was cut,
		// not the exact figure, which is a presentation default.
		expect(line).not.toContain(subject);
		expect(line).toContain("...");
	});

	it("counts the recipients it did not name", () => {
		const line = shown(
			renderGoogleCall(
				{ action: "send_email", to: ["a@x.com", "b@x.com", "c@x.com"] },
				theme,
			),
		);

		expect(line).toContain("a@x.com");
		expect(line).toContain("+2");
	});
});

describe("rendering a Google result", () => {
	const noOptions = {};

	it("colours a failure as a failure", () => {
		const rendered = shown(
			renderGoogleResult(
				{
					content: [
						{
							type: "text",
							text: "Google Workspace API error: quota exceeded",
						},
					],
				},
				noOptions,
				theme,
			),
		);

		expect(rendered).toContain("<error>");
		expect(rendered).toContain("quota exceeded");
	});

	it("marks a cancelled action as a warning, not an error", () => {
		const rendered = shown(
			renderGoogleResult(
				{ content: [{ type: "text", text: "✗ Event creation cancelled" }] },
				noOptions,
				theme,
			),
		);

		expect(rendered).toContain("<warning>");
		expect(rendered).not.toContain("<error>");
	});

	it("reads a result whose first block carries no text", () => {
		// A block may be an image, which carries no text at all, and
		// such a result still has to render from its details.
		//
		// This does not guard the narrowing that replaced the old
		// `content[0].text` read: that read fell back to an empty
		// string, so it behaved correctly here and this test passes
		// against both versions. It was a type describing blocks pi
		// never sends, not a defect, and only tsc can hold that. What
		// is pinned here is the behaviour itself.
		const rendered = shown(
			renderGoogleResult(
				{
					content: [{ type: "image" }],
					details: {
						messages: [{ subject: "Still summarized", from: "a@x.com" }],
					},
				},
				noOptions,
				theme,
			),
		);

		expect(rendered).toContain("Still summarized");
	});

	it("survives a result with no blocks at all", () => {
		expect(() => renderGoogleResult({}, noOptions, theme)).not.toThrow();
	});
});
