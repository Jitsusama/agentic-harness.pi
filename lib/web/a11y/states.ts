/**
 * The states an element is in, said the same way everywhere.
 *
 * The outline and the reading differ in layout but must not
 * differ on facts: if one says a control is disabled, so does
 * the other. Both ask this module.
 */

import type { AxNode } from "./tree.js";

/** How the caller wants the states phrased. */
export interface StateOptions {
	/** Leave the heading level out, for a reader that says it with the role. */
	readonly skipLevel?: boolean;
}

/**
 * The states worth saying out loud, in a fixed order so two
 * outlines of the same page read the same way.
 *
 * Only states that are in effect are reported. A field that is
 * not required and not invalid is the ordinary case, and
 * saying so on every line would bury the lines that matter.
 */
export function describeStates(
	node: AxNode,
	options: StateOptions = {},
): string[] {
	const { properties: props } = node;
	const states: string[] = [];

	if (props.level !== undefined && !options.skipLevel) {
		states.push(`level ${props.level}`);
	}
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
