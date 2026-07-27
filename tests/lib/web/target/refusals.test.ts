import { describe, expect, it } from "vitest";
import type { AxNode } from "../../../../lib/web/a11y/index.js";
import {
	ambiguityRefusal,
	describeRefusal,
	describeTarget,
	notFoundRefusal,
} from "../../../../lib/web/target/refusals.js";
import { resolveTarget } from "../../../../lib/web/target/target.js";

let nextId = 1;

function node(role: string, name: string, children: AxNode[] = []): AxNode {
	return { role, name, backendDomId: nextId++, properties: {}, children };
}

describe("notFoundRefusal candidates are actionable", () => {
	it("never offers a text node as something to act on", () => {
		// Text carrying a near-miss name is not a thing a caller
		// can click, so proposing it wastes the retry.
		const root = node("RootWebArea", "Shop", [
			node("StaticText", "Checkout"),
			node("button", "Check out"),
		]);

		const refusal = notFoundRefusal(root, {
			role: "button",
			name: "Checkout",
		});

		expect(refusal.candidates.length).toBeGreaterThan(0);
		for (const candidate of refusal.candidates) {
			expect(candidate.target.role).not.toBe("StaticText");
		}
	});

	it("does not call a page close to nothing when it holds the name as text", () => {
		// A div styled to look like a button, or a label whose control
		// is named something else, is the commonest reason a target
		// misses. Saying nothing on the page is close sends the caller
		// looking for a spelling mistake, when the page has the words
		// right there and only the role is wrong. The text still must
		// not be offered as a thing to act on.
		const root = node("RootWebArea", "Shop", [node("StaticText", "Save")]);

		const refusal = notFoundRefusal(root, { role: "button", name: "Save" });
		const said = describeRefusal({ role: "button", name: "Save" }, refusal);

		expect(refusal.candidates).toEqual([]);
		expect(said).not.toContain("nothing on the page is close to it");
		expect(said).toContain("Save");
		expect(said).toContain("StaticText");
	});

	it("still says a page is close to nothing when it is", () => {
		const root = node("RootWebArea", "Shop", [node("button", "Basket")]);

		const refusal = notFoundRefusal(root, { role: "button", name: "Save" });
		const said = describeRefusal({ role: "button", name: "Save" }, refusal);

		expect(said).toContain("nothing on the page is close to it");
	});

	it("does not cite the page root as if it were a landmark", () => {
		// Everything is in the root, so saying so narrows nothing.
		const root = node("RootWebArea", "Rich", [node("button", "Details")]);

		const refusal = notFoundRefusal(root, {
			role: "button",
			name: "Detials",
		});

		expect(
			describeRefusal({ role: "button", name: "Detials" }, refusal),
		).not.toContain("RootWebArea");
	});

	it("still offers a real control when only text matched better", () => {
		const root = node("RootWebArea", "Shop", [
			node("StaticText", "Submit"),
			node("button", "Submit order"),
		]);

		const refusal = notFoundRefusal(root, { role: "button", name: "Submit" });

		expect(refusal.candidates.map((c) => c.target.name)).toEqual([
			"Submit order",
		]);
	});
});

describe("ambiguityRefusal", () => {
	it("offers a candidate for every element the target matched", () => {
		const root = node("WebArea", "Shop", [
			node("button", "Add to cart"),
			node("button", "Add to cart"),
			node("button", "Add to cart"),
		]);

		const refusal = ambiguityRefusal(root, {
			role: "button",
			name: "Add to cart",
		});

		expect(refusal.reason).toBe("ambiguous");
		expect(refusal.candidates).toHaveLength(3);
	});

	it("offers candidates that each resolve to one distinct element", () => {
		const root = node("WebArea", "Shop", [
			node("navigation", "Main", [node("link", "Home")]),
			node("contentinfo", "Footer", [node("link", "Home")]),
		]);

		const refusal = ambiguityRefusal(root, { role: "link", name: "Home" });

		const resolved = refusal.candidates.map((candidate) =>
			resolveTarget(root, candidate.target),
		);
		for (const resolution of resolved) {
			expect(resolution.kind).toBe("resolved");
		}
		const ids = resolved.map((r) =>
			r.kind === "resolved" ? r.backendDomId : 0,
		);
		expect(new Set(ids).size).toBe(resolved.length);
	});

	it("names the containing landmark so the caller can tell them apart", () => {
		const root = node("WebArea", "Shop", [
			node("navigation", "Main", [node("link", "Home")]),
			node("contentinfo", "Footer", [node("link", "Home")]),
		]);

		const refusal = ambiguityRefusal(root, { role: "link", name: "Home" });

		expect(refusal.candidates.map((c) => c.hint).join(" ")).toContain("Main");
		expect(refusal.candidates.map((c) => c.hint).join(" ")).toContain("Footer");
	});

	it("falls back to ordinals when no container tells them apart", () => {
		const root = node("WebArea", "Shop", [
			node("button", "Add to cart"),
			node("button", "Add to cart"),
		]);

		const refusal = ambiguityRefusal(root, {
			role: "button",
			name: "Add to cart",
		});

		expect(refusal.candidates.map((c) => c.target.ordinal)).toEqual([1, 2]);
	});

	it("reports no candidates when the target matched nothing", () => {
		const root = node("WebArea", "Shop", [node("button", "Checkout")]);

		const refusal = ambiguityRefusal(root, {
			role: "button",
			name: "Add to cart",
		});

		expect(refusal.candidates).toEqual([]);
	});
});

describe("notFoundRefusal", () => {
	it("suggests the element whose name differs only in case", () => {
		const root = node("WebArea", "Shop", [node("button", "Sign In")]);

		const refusal = notFoundRefusal(root, {
			role: "button",
			name: "sign in",
		});

		expect(refusal.reason).toBe("notFound");
		expect(refusal.candidates[0]?.target.name).toBe("Sign In");
	});

	it("suggests an element whose name contains what was asked for", () => {
		const root = node("WebArea", "Shop", [node("link", "Sign in here")]);

		const refusal = notFoundRefusal(root, {
			role: "link",
			name: "Sign in",
		});

		expect(refusal.candidates[0]?.target.name).toBe("Sign in here");
	});

	it("suggests an element a typo away", () => {
		const root = node("WebArea", "Shop", [node("button", "Checkout")]);

		const refusal = notFoundRefusal(root, {
			role: "button",
			name: "Chekout",
		});

		expect(refusal.candidates[0]?.target.name).toBe("Checkout");
	});

	it("prefers the asked-for role over a nearer name elsewhere", () => {
		const root = node("WebArea", "Shop", [
			node("link", "Save"),
			node("button", "Save"),
		]);

		const refusal = notFoundRefusal(root, { role: "button", name: "save" });

		expect(refusal.candidates[0]?.target.role).toBe("button");
	});

	it("names the role it found when it differs from the one asked for", () => {
		const root = node("WebArea", "Shop", [node("link", "Sign in")]);

		const refusal = notFoundRefusal(root, {
			role: "button",
			name: "Sign in",
		});

		expect(refusal.candidates[0]?.target.role).toBe("link");
		expect(refusal.candidates[0]?.hint).toContain("link");
	});

	it("keeps the suggestion list short enough to read", () => {
		const root = node(
			"WebArea",
			"Shop",
			Array.from({ length: 10 }, (_, i) => node("button", `Save ${i}`)),
		);

		const refusal = notFoundRefusal(root, { role: "button", name: "Save" });

		expect(refusal.candidates.length).toBeLessThanOrEqual(3);
	});

	it("offers nothing rather than nonsense when nothing is close", () => {
		const root = node("WebArea", "Shop", [node("button", "Checkout")]);

		const refusal = notFoundRefusal(root, {
			role: "button",
			name: "Subscribe to newsletter",
		});

		expect(refusal.candidates).toEqual([]);
	});

	it("offers candidates that resolve", () => {
		const root = node("WebArea", "Shop", [
			node("navigation", "Main", [node("link", "Home page")]),
		]);

		const refusal = notFoundRefusal(root, { role: "link", name: "Home" });

		expect(refusal.candidates.length).toBeGreaterThan(0);
		for (const candidate of refusal.candidates) {
			expect(resolveTarget(root, candidate.target).kind).toBe("resolved");
		}
	});
});

describe("describeRefusal", () => {
	it("says what was not found, and what to try instead", () => {
		const root = node("WebArea", "Shop", [node("button", "Sign In")]);
		const target = { role: "button", name: "sign in" };

		const text = describeRefusal(target, notFoundRefusal(root, target));

		expect(text).toContain("button");
		expect(text).toContain("sign in");
		expect(text).toContain("Sign In");
	});

	it("says how many matched, and how to tell them apart", () => {
		const root = node("WebArea", "Shop", [
			node("navigation", "Main", [node("link", "Home")]),
			node("contentinfo", "Footer", [node("link", "Home")]),
		]);
		const target = { role: "link", name: "Home" };

		const text = describeRefusal(target, ambiguityRefusal(root, target));

		expect(text).toContain("2");
		expect(text).toContain("Main");
		expect(text).toContain("Footer");
	});

	it("spells out an ordinal candidate as a usable instruction", () => {
		const root = node("WebArea", "Shop", [
			node("button", "Add to cart"),
			node("button", "Add to cart"),
		]);
		const target = { role: "button", name: "Add to cart" };

		const text = describeRefusal(target, ambiguityRefusal(root, target));

		expect(text).toContain("ordinal 1");
		expect(text).toContain("ordinal 2");
	});

	it("admits when it has nothing to suggest", () => {
		const root = node("WebArea", "Shop", [node("button", "Checkout")]);
		const target = { role: "button", name: "Subscribe to newsletter" };

		const text = describeRefusal(target, notFoundRefusal(root, target));

		expect(text).toContain("Subscribe to newsletter");
		expect(text.toLowerCase()).toContain("nothing");
	});

	it("reports what blocked an element that would not act", () => {
		const text = describeRefusal(
			{ role: "button", name: "Buy" },
			{
				reason: "notActionable",
				candidates: [],
				waitedMs: 2000,
				blocking: 'occluded by dialog "Cookies"',
			},
		);

		expect(text).toContain("2000");
		expect(text).toContain("Cookies");
	});

	it("writes a target the way a caller would pass it back", () => {
		// The refusals a tool writes for itself need the same rule,
		// or they print name "undefined" for a control that has none.
		expect(describeTarget({ role: "button" })).toBe("role button");
		expect(describeTarget({ role: "button", name: "Save" })).toBe(
			'role button name "Save"',
		);
		expect(describeTarget({ role: "link", name: "Help", ordinal: 2 })).toBe(
			'role link name "Help" ordinal 2',
		);
	});

	it("suggests same-role controls when no name was asked for", () => {
		// Every name contains the empty string, so a nameless target
		// used to make near misses of the whole page. What is useful
		// is the controls that share the role and do have a name.
		const root = node("RootWebArea", "Shop", [
			node("button", "Save"),
			node("link", "Help"),
		]);

		const refusal = notFoundRefusal(root, { role: "button" });
		const text = describeRefusal({ role: "button" }, refusal);

		expect(text).toContain('role button name "Save"');
		expect(text).not.toContain("Help");
	});

	it("describes a nameless target by role alone", () => {
		// What a refusal prints is what the caller passes back, and
		// plenty of real controls (an icon button, a bare input) have
		// no accessible name to pass.
		const text = describeRefusal(
			{ role: "button", name: "" },
			{ reason: "notFound", candidates: [] },
		);

		expect(text).toContain("role button");
		expect(text).not.toContain('name ""');
	});

	it("still says which name it could not find", () => {
		const text = describeRefusal(
			{ role: "button", name: "Buy" },
			{ reason: "notFound", candidates: [] },
		);

		expect(text).toContain('role button name "Buy"');
	});
});
