/**
 * How the Slack tool draws a result, read with a theme that names each
 * piece's colour, for the tests that pin what a result looks like.
 */

import slackIntegration from "../../../extensions/slack-integration/index.ts";

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

/** How the tool draws a result that says `text` and carries `details`. */
export function drawn(
	text: string,
	details: unknown = {},
	expanded = false,
): string {
	return slack()
		.renderResult(
			{ content: [{ type: "text", text }], details },
			{ expanded },
			theme,
			{ isError: false, lastComponent: undefined },
		)
		.render(120)
		.join("\n");
}
