import { describe, expect, it } from "vitest";
import slackIntegration from "../../../extensions/slack-integration/index.ts";
import { OUTCOME_GLYPH } from "../../../lib/ui/index.ts";

/**
 * How the Slack tool draws a send that did not happen.
 *
 * A cancel is somebody saying no, which neither passed nor failed, so it
 * is drawn dim; a failure is drawn as one. Both used to share a ballot x
 * and the warning colour, so a send that broke halfway through a thread
 * looked like a send somebody declined.
 */

interface Tool {
	name: string;
	renderResult(
		result: { content: { type: string; text: string }[]; details: unknown },
		options: { expanded: boolean },
		palette: typeof theme,
		context: { isError: boolean; lastComponent: undefined },
	): { render(width: number): string[] };
}

/** The Slack tool, as the extension registered it. */
function slack(): Tool {
	let found: Tool | undefined;
	// Every other call the extension makes as it loads is answered with
	// nothing, since drawing a result reads none of them.
	const events = { on: () => undefined, emit: () => undefined };
	const pi = new Proxy(
		{},
		{
			get: (_target, name) => {
				if (name === "events") return events;
				if (name === "registerTool")
					return (definition: Tool) => {
						found = definition;
					};
				return () => undefined;
			},
		},
	);
	slackIntegration(pi as never);
	if (!found) throw new Error("the extension registered no tool");
	return found;
}

/** A theme that says which colour each piece was given. */
const theme = {
	fg: (colour: string, text: string) => `<${colour}>${text}`,
	bold: (text: string) => text,
};

/** How the tool draws a result that says only this. */
function drawn(text: string): string {
	return slack()
		.renderResult(
			{ content: [{ type: "text", text }], details: {} },
			{ expanded: false },
			theme,
			{ isError: false, lastComponent: undefined },
		)
		.render(120)
		.join("\n");
}

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
