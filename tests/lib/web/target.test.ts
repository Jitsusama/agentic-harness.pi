import { describe, expect, it } from "vitest";
import type { AxNode } from "../../../lib/web/a11y.js";
import { resolveTarget } from "../../../lib/web/target.js";

function n(
	role: string,
	name: string,
	backendDomId?: number,
	children: AxNode[] = [],
): AxNode {
	return backendDomId === undefined
		? { role, name, children }
		: { role, name, backendDomId, children };
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
