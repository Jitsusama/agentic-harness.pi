/**
 * Rendering the accessibility tree as an outline.
 *
 * The outline is the model's default view of a page: a nested
 * role-and-name listing that reads like a description, with the
 * states that change what a caller can do shown inline. It is
 * the surface act refusals, audits and page reads all quote.
 */

import type { AxNode } from "./tree.js";

/** Roles that add no meaning on their own and are folded away when unnamed. */
const NOISE_ROLES = new Set([
	"generic",
	"none",
	"presentation",
	"document",
	"RootWebArea",
	"InlineTextBox",
	"StaticText",
	"text",
]);

/** Whether a node earns its own line in the outline. */
function isMeaningful(node: AxNode): boolean {
	if (node.name.trim().length > 0) return true;
	return !NOISE_ROLES.has(node.role);
}

/**
 * Render the tree as a nested role-and-name outline, with the
 * states that change what a caller can do shown inline. A node
 * that is not meaningful (a noise role with no name) is folded
 * away: its children rise to its own indentation, so wrappers
 * never add depth while their named descendants survive.
 */
export function renderAxOutline(root: AxNode): string {
	const lines: string[] = [];
	const walk = (node: AxNode, depth: number): void => {
		const shown = isMeaningful(node);
		if (shown) {
			const states = describeStates(node);
			const suffix = states.length ? ` ${states.join(" ")}` : "";
			lines.push(`${"  ".repeat(depth)}${node.role} "${node.name}"${suffix}`);
		}
		const childDepth = shown ? depth + 1 : depth;
		for (const child of node.children) walk(child, childDepth);
	};
	// The root itself is the page container; render its children.
	for (const child of root.children) walk(child, 0);
	return lines.join("\n");
}

/**
 * The states worth saying out loud, in a fixed order so two
 * outlines of the same page read the same way.
 *
 * Only states that are in effect are reported. A field that is
 * not required and not invalid is the ordinary case, and
 * saying so on every line would bury the lines that matter.
 */
function describeStates(node: AxNode): string[] {
	const { properties: props } = node;
	const states: string[] = [];

	if (props.level !== undefined) states.push(`level ${props.level}`);
	if (props.checked === "true") states.push("checked");
	if (props.checked === "mixed") states.push("partially checked");
	if (props.disabled === true) states.push("disabled");
	if (props.expanded === true) states.push("expanded");
	if (props.expanded === false) states.push("collapsed");
	if (props.selected === true) states.push("selected");
	if (props.required === true) states.push("required");
	if (isInvalid(props.invalid)) states.push("invalid");
	if (props.readonly === true) states.push("read only");
	if (props.focused === true) states.push("focused");
	if (typeof props.live === "string" && props.live && props.live !== "off") {
		states.push(`live ${props.live}`);
	}
	if (node.value !== undefined && node.value !== "") {
		states.push(`value ${JSON.stringify(node.value)}`);
	}
	return states;
}

/** Chrome reports validity as a token, where "false" means valid. */
function isInvalid(invalid: string | number | boolean | undefined): boolean {
	return invalid !== undefined && invalid !== false && invalid !== "false";
}
