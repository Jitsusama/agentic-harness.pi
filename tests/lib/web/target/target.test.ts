import { describe, expect, it } from "vitest";
import type { AxNode } from "../../../../lib/web/a11y/index.js";
import { resolveTarget } from "../../../../lib/web/target/target.js";

function n(
	role: string,
	name: string,
	backendDomId?: number,
	children: AxNode[] = [],
): AxNode {
	return backendDomId === undefined
		? { role, name, properties: {}, children }
		: { role, name, backendDomId, properties: {}, children };
}

const page: AxNode = n("RootWebArea", "", undefined, [
	n("navigation", "Primary", 1, [n("link", "Home", 2)]),
	n("region", "Recommended", 3, [n("button", "Add to cart", 4)]),
	n("region", "Cart", 5, [n("button", "Add to cart", 6)]),
	n("button", "Sign in", 7),
]);

describe("resolveTarget", () => {
	it("resolves a unique role and name to its backend id", () => {
		expect(resolveTarget(page, { role: "button", name: "Sign in" })).toEqual({
			kind: "resolved",
			backendDomId: 7,
		});
	});

	it("reports ambiguity when role and name match more than one node", () => {
		expect(
			resolveTarget(page, { role: "button", name: "Add to cart" }),
		).toEqual({
			kind: "ambiguous",
			count: 2,
		});
	});

	it("disambiguates by container", () => {
		expect(
			resolveTarget(page, {
				role: "button",
				name: "Add to cart",
				container: { name: "Cart" },
			}),
		).toEqual({ kind: "resolved", backendDomId: 6 });
	});

	it("disambiguates by a name-scoped ordinal", () => {
		expect(
			resolveTarget(page, { role: "button", name: "Add to cart", ordinal: 1 }),
		).toEqual({ kind: "resolved", backendDomId: 4 });
	});

	it("reports not found when nothing matches", () => {
		expect(resolveTarget(page, { role: "button", name: "Checkout" })).toEqual({
			kind: "notFound",
		});
	});
});

describe("a resolution names one node, not a position", () => {
	it("resolves a container-scoped target to that container's node", () => {
		// The click path used to re-derive the element from a
		// page-wide aria selector and take index 0, which clicked
		// the first row's Delete whichever row was asked for. The
		// resolution has to carry an identity the click can use,
		// because a position in one list means nothing in another.
		const rows = n("RootWebArea", "Rows", undefined, [
			n("group", "Row One", 10, [n("button", "Delete", 11)]),
			n("group", "Row Two", 20, [n("button", "Delete", 21)]),
			n("group", "Row Three", 30, [n("button", "Delete", 31)]),
		]);

		for (const [name, backendDomId] of [
			["Row One", 11],
			["Row Two", 21],
			["Row Three", 31],
		] as const) {
			expect(
				resolveTarget(rows, {
					role: "button",
					name: "Delete",
					container: { name },
				}),
			).toEqual({ kind: "resolved", backendDomId });
		}
	});

	it("counts the ordinal within the container, not the page", () => {
		const root = n("RootWebArea", "Rows", undefined, [
			n("group", "Left", 10, [n("button", "Go", 11), n("button", "Go", 12)]),
			n("group", "Right", 20, [n("button", "Go", 21), n("button", "Go", 22)]),
		]);

		expect(
			resolveTarget(root, {
				role: "button",
				name: "Go",
				container: { name: "Right" },
				ordinal: 2,
			}),
		).toEqual({ kind: "resolved", backendDomId: 22 });
	});
});
