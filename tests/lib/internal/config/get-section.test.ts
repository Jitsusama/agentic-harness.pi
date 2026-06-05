import { describe, expect, it } from "vitest";
import {
	getSection,
	type PackageConfig,
	type SectionParse,
} from "../../../../lib/internal/config/loader";

interface Demo {
	root: string;
}

/** Parser that defaults a missing/undefined section and rejects bad shapes. */
const parseDemo: SectionParse<Demo> = (value) => {
	if (value === undefined) return { ok: true, value: { root: "default" } };
	if (typeof value !== "object" || value === null) {
		return { ok: false, error: "must be an object" };
	}
	const root = (value as Record<string, unknown>).root;
	if (typeof root !== "string")
		return { ok: false, error: "root must be a string" };
	return { ok: true, value: { root } };
};

function config(sections: Record<string, unknown>): PackageConfig {
	return { version: 1, sections };
}

describe("getSection", () => {
	it("parses a present, valid section", () => {
		const result = getSection(
			config({ demo: { root: "/x" } }),
			"demo",
			parseDemo,
		);
		expect(result).toEqual({ value: { root: "/x" } });
	});

	it("returns parser defaults when the section is absent", () => {
		const result = getSection(config({}), "demo", parseDemo);
		expect(result).toEqual({ value: { root: "default" } });
	});

	it("degrades a present-but-invalid section to defaults with a warning", () => {
		const result = getSection(config({ demo: { root: 7 } }), "demo", parseDemo);
		expect(result.value).toEqual({ root: "default" });
		expect(result.warning).toMatch(/root must be a string/);
	});
});
