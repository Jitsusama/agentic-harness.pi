/**
 * The page as a screen reader narrates it.
 *
 * The outline shows how a page is built; a reading shows what
 * it is like to use without sight. Landmarks are announced on
 * entry and exit, headings carry their level, controls carry
 * the states that change how they behave, and text is read as
 * prose rather than as elements.
 */

import { describeStates } from "./states.js";
import type { AxNode } from "./tree.js";

/**
 * Roles a reader passes through without a word. They exist to
 * group or to carry text, and announcing them would put
 * scaffolding between the listener and the page.
 */
const SILENT_ROLES = new Set([
	"generic",
	"none",
	"presentation",
	"document",
	"RootWebArea",
	"paragraph",
	"LabelText",
	"listitem",
	"MenuListPopup",
]);

/** Roles that carry text and nothing else. */
const TEXT_ROLES = new Set(["StaticText", "InlineTextBox", "text"]);

/** Landmarks a reader announces entering and leaving. */
const LANDMARK_ROLES = new Set([
	"banner",
	"complementary",
	"contentinfo",
	"form",
	"main",
	"navigation",
	"region",
	"search",
]);

/** Whether entering this node is worth announcing. */
function isRegion(node: AxNode): boolean {
	if (LANDMARK_ROLES.has(node.role)) return true;
	if (node.role === "list") return true;
	const live = node.properties.live;
	return typeof live === "string" && live !== "" && live !== "off";
}

/** Narrate a tree in reading order. */
export function renderReading(root: AxNode): string {
	const lines: string[] = [];

	const read = (node: AxNode, depth: number): void => {
		const pad = "  ".repeat(depth);

		if (TEXT_ROLES.has(node.role)) {
			if (node.name.trim()) lines.push(`${pad}${node.name}`);
			return;
		}

		if (SILENT_ROLES.has(node.role) && !node.name.trim()) {
			for (const child of node.children) read(child, depth);
			return;
		}

		if (isRegion(node)) {
			lines.push(`${pad}${announce(node)}`);
			for (const child of node.children) read(child, depth + 1);
			lines.push(
				`${pad}end of ${node.role}${node.name ? `, ${node.name}` : ""}`,
			);
			return;
		}

		lines.push(`${pad}${announce(node)}`);
		for (const child of node.children) read(child, depth);
	};

	for (const child of root.children) read(child, 0);
	return lines.join("\n");
}

/** What a reader says on reaching this element. */
function announce(node: AxNode): string {
	const parts = [roleLabel(node)];
	if (node.name.trim()) parts.push(node.name);
	if (node.role === "list") parts.push(itemCount(node));
	parts.push(...describeStates(node, { skipLevel: true }));
	return parts.join(", ");
}

/** How many items a list holds, said the way it is heard. */
function itemCount(list: AxNode): string {
	const items = list.children.filter(
		(child) => child.role === "listitem",
	).length;
	return items === 1 ? "1 item" : `${items} items`;
}

/** The role as spoken, with a heading's level folded in. */
function roleLabel(node: AxNode): string {
	const level = node.properties.level;
	if (node.role === "heading" && level !== undefined) {
		return `heading level ${level}`;
	}
	return node.role;
}
