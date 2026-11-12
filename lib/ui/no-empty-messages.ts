/**
 * A custom message whose renderer draws nothing takes no row on pi's
 * screen. pi's CustomMessageComponent puts a blank line above whatever its
 * renderer draws, so a message an extension hides, as /mesh quiet does,
 * still left one empty row per message. Joel, 11 November 2026: "for mesh
 * quiet, it is still printing blank lines to my pi terminal."
 *
 * The wrap is stateless and goes on pi's prototype once per process: pi's
 * own render is kept under a Symbol.for key on the prototype, so a reload,
 * which evaluates this module afresh, finds it there and wraps pi's render
 * again rather than wrapping a wrapper.
 */
import { CustomMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

/** Where pi's own render waits, the same in every evaluation of this module. */
const PI_RENDER = Symbol.for("agentic-harness.pi/custom-message-render");

/** A render as a component's prototype holds it. */
type Render = (this: CustomMessageComponent, width: number) => string[];

/** The prototype, seen as a place that can hold pi's render beside its own. */
type Prototype = { render: Render; [PI_RENDER]?: Render };

/** A child's rows from pi's last layout of its container. */
type Layout = {
	width: number;
	children: { component: unknown; height: number }[];
};

/** Makes a custom message that its renderer drew nothing for take no row. */
export function dropEmptyMessages(): void {
	const prototype: Prototype = CustomMessageComponent.prototype;
	const piRender = prototype[PI_RENDER] ?? prototype.render;
	prototype[PI_RENDER] = piRender;
	prototype.render = function render(width: number): string[] {
		const lines = piRender.call(this, width);
		return drewNothing(this, width) ? [] : lines;
	};
}

/**
 * Whether the renderer's component drew no rows at `width`, read from the
 * layout pi's render just kept where it keeps one, else by drawing it.
 * A message pi draws itself, having no renderer's component, drew something.
 */
function drewNothing(message: CustomMessageComponent, width: number): boolean {
	const drawn: unknown = Reflect.get(message, "customComponent");
	if (!isComponent(drawn)) return false;
	const layout: unknown = Reflect.get(message, "mouseLayout");
	const kept =
		isLayout(layout) && layout.width === width
			? layout.children.find((child) => child.component === drawn)
			: undefined;
	return (kept?.height ?? drawn.render(width).length) === 0;
}

/** Whether `value` can be drawn. */
function isComponent(value: unknown): value is Component {
	return (
		typeof value === "object" &&
		value !== null &&
		"render" in value &&
		typeof value.render === "function"
	);
}

/** Whether `value` is the layout pi's container keeps of its last render. */
function isLayout(value: unknown): value is Layout {
	return (
		typeof value === "object" &&
		value !== null &&
		"width" in value &&
		typeof value.width === "number" &&
		"children" in value &&
		Array.isArray(value.children)
	);
}
