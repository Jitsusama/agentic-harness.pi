/**
 * How a mesh_send call is drawn: as pi draws a tool with no drawing of
 * its own, except that while the session is quiet it draws nothing until
 * the person expands the screen (ctrl+o, as for tool output).
 *
 * Joel, 11 November 2026: "mesh quiet is still showing me mesh messages
 * you send". Quiet kept other sessions' news off the screen, but the
 * session's own sends to them still drew a block each. A tool that draws
 * its own frame (`renderShell: "self"`) and draws no lines takes no line
 * at all, where pi's own frame would leave a blank one, so the drawing
 * here is the frame pi would draw: a blank line, the call, the result
 * and a blank line, on the background of how the call went. Quiet is
 * read as the row is drawn, so turning it on or off redraws every send
 * already on the screen.
 */

import {
	type AgentToolResult,
	keyHint,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Spacer, Text } from "@earendil-works/pi-tui";

/** What the call's drawing and the result's share for one row. */
interface Row {
	/** Whether the result has been drawn, which closes the frame. */
	result?: boolean;
}

/** The slice of pi's ToolRenderContext the drawing reads. */
export interface SendContext {
	readonly state: Row;
	readonly expanded: boolean;
	readonly isPartial: boolean;
	readonly isError: boolean;
	readonly outputPad: number;
	/** What this slot drew last time, handed back to be drawn again. */
	readonly lastComponent: Component | undefined;
}

/** What a slot's component draws, replaced each time pi asks again. */
interface Slot {
	render: (width: number) => string[];
	boxes: readonly Box[];
}

/** The call's arguments shown collapsed, past which they are cut. */
const COLLAPSED_ARGS_CHARS = 100;

/** The result's lines shown collapsed. */
const PREVIEW_LINES = 10;

/** What pi needs of a tool to draw it. */
export interface SendDrawing {
	readonly renderShell: "self";
	renderCall(
		args: Readonly<Record<string, unknown>>,
		theme: Theme,
		context: SendContext,
	): Component;
	renderResult(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: SendContext,
	): Component;
}

/** mesh_send's drawing, hidden while `quiet` says so and the row is collapsed. */
export function sendDrawing(quiet: () => boolean): SendDrawing {
	const shown =
		(context: SendContext, draw: (width: number) => string[]) =>
		(width: number): string[] =>
			quiet() && !context.expanded ? [] : draw(width);
	const slots = new WeakMap<Component, Slot>();
	/**
	 * The slot's component, the one pi kept when it is ours, so a row drawn
	 * again stays one row rather than leaving its old drawing beside it.
	 */
	const drawn = (
		lastComponent: Component | undefined,
		render: (width: number) => string[],
		boxes: readonly Box[],
	): Component => {
		const kept = lastComponent && slots.get(lastComponent);
		if (lastComponent && kept) {
			kept.render = render;
			kept.boxes = boxes;
			return lastComponent;
		}
		const slot: Slot = { render, boxes };
		const component: Component = {
			render: (width) => slot.render(width),
			invalidate: () => {
				for (const box of slot.boxes) box.invalidate();
			},
		};
		slots.set(component, slot);
		return component;
	};
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const bg = background(context, theme);
			const head = new Box(context.outputPad, 0, bg);
			head.addChild(new Spacer(1));
			head.addChild(new Text(callText(args, theme, context.expanded), 0, 0));
			const foot = new Box(context.outputPad, 0, bg);
			foot.addChild(new Spacer(1));
			return drawn(
				context.lastComponent,
				shown(context, (width) =>
					context.state.result
						? head.render(width)
						: [...head.render(width), ...foot.render(width)],
				),
				[head, foot],
			);
		},
		renderResult(result, options, theme, context) {
			context.state.result = true;
			const body = new Box(context.outputPad, 0, background(context, theme));
			const text = resultText(result, options.expanded, theme);
			if (text !== "") body.addChild(new Text(text, 0, 0));
			body.addChild(new Spacer(1));
			return drawn(
				context.lastComponent,
				shown(context, (width) => body.render(width)),
				[body],
			);
		},
	};
}

/** The row's background, as pi picks it for its own frame. */
function background(
	context: SendContext,
	theme: Theme,
): (text: string) => string {
	let colour: "toolPendingBg" | "toolErrorBg" | "toolSuccessBg" =
		"toolSuccessBg";
	if (context.isError) colour = "toolErrorBg";
	if (context.isPartial) colour = "toolPendingBg";
	return (text) => theme.bg(colour, text);
}

/** The call as pi writes one: the tool's name, then its arguments. */
function callText(
	args: Readonly<Record<string, unknown>>,
	theme: Theme,
	expanded: boolean,
): string {
	const header = theme.fg("toolTitle", theme.bold("mesh_send"));
	const entries = Object.entries(args);
	if (entries.length === 0) return header;
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const text =
				typeof value === "string"
					? value
					: (JSON.stringify(value, null, 2) ?? String(value));
			const flat = text.replace(/\t/g, "   ").replace(/\r/g, "");
			return `  ${key}: ${flat.split("\n").join("\n    ")}`;
		});
		return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
	}
	const pairs = entries
		.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`)
		.join(" ");
	const preview =
		pairs.length > COLLAPSED_ARGS_CHARS
			? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...`
			: pairs;
	return `${header} ${theme.fg("muted", preview)}`;
}

/** The answer's text, its first lines while collapsed, as pi shows output. */
function resultText(
	result: AgentToolResult<unknown>,
	expanded: boolean,
	theme: Theme,
): string {
	const output = result.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.replace(/\r/g, "");
	if (output === "") return "";
	const lines = output.split("\n");
	const kept = expanded ? lines : lines.slice(0, PREVIEW_LINES);
	const text = kept.map((line) => theme.fg("toolOutput", line)).join("\n");
	const remaining = lines.length - kept.length;
	if (remaining === 0) return text;
	return `${text}${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}
