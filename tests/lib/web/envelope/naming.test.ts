import path from "node:path";
import { describe, expect, it } from "vitest";
import { pathComponent } from "../../../../lib/web/envelope/naming.js";

describe("turning a caller-chosen word into a path component", () => {
	const root = "/data/baselines";
	const under = (name: string) =>
		path.join(root, pathComponent(name)).startsWith(`${root}/`);

	it("leaves an ordinary name alone", () => {
		expect(pathComponent("checkout-empty")).toBe("checkout-empty");
	});

	it("cannot be walked out of its directory", () => {
		// A session name is chosen by whoever is driving. Unsanitized,
		// "../../../../../../tmp/evil" put a baseline write at
		// /Users/tmp/evil instead of under the extension's data dir.
		for (const hostile of [
			"../../../../../../tmp/evil",
			"..",
			".",
			"../sibling",
			"/etc/passwd",
			"a/b/c",
			"..\\..\\windows",
		]) {
			expect(under(hostile)).toBe(true);
		}
	});

	it("always returns something joinable", () => {
		// An empty component makes path.join return the parent, which
		// is how a file lands one directory above where it belongs.
		for (const empty of ["", "/", "///", "..."]) {
			expect(pathComponent(empty)).not.toBe("");
			expect(under(empty)).toBe(true);
		}
	});

	it("does not hide what it writes", () => {
		expect(pathComponent(".hidden")).toBe("hidden");
	});
});
