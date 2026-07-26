/**
 * Source map decoding.
 *
 * The fixtures are real esbuild output, not hand-written maps:
 * a bundled and minified module and its stylesheet, both on one
 * line, which is exactly the case where a raw position is
 * useless and a mapped one is the whole answer.
 */

import { describe, expect, it } from "vitest";
import {
	authoredPosition,
	decodeMappings,
	decodeVlq,
	parseSourceMap,
	readSourceMap,
	resolveMapUrl,
} from "../../../../lib/web/sourcemap/mappings.js";

/** esbuild --bundle --minify --sourcemap of two small modules. */
const SCRIPT_MAP = {
	version: 3,
	sources: ["src/greet.js", "src/app-main.js"],
	sourcesContent: [
		"export function greet(name) {\n  if (!name) {\n" +
			'    throw new Error("greet needs a name");\n  }\n' +
			"  return `Hello, ${" +
			"name}`;\n}\n",
		'import { greet } from "./greet.js";\n\nexport function boom() {\n  return greet(null);\n}\n\nwindow.boom = boom;\nwindow.greet = greet;\n',
	],
	names: ["greet", "name", "boom", "greet"],
	mappings:
		"MAAO,SAASA,EAAMC,EAAM,CAC1B,GAAI,CAACA,EACH,MAAM,IAAI,MAAM,oBAAoB,EAEtC,MAAO,UAAUA,CAAI,EACvB,CCHO,SAASC,GAAO,CACrB,OAAOC,EAAM,IAAI,CACnB,CAEA,OAAO,KAAOD,EACd,OAAO,MAAQC",
};

/** esbuild --bundle --minify --sourcemap of one stylesheet. */
const STYLE_MAP = {
	version: 3,
	sources: ["src/theme.css"],
	mappings:
		"AAAA,CAAC,MACC,MAAO,KADT,QAEW,IACX,CACA,CAJC,MAIM,CAAC,MACN,YAAa,GACf",
};

describe("decodeVlq", () => {
	it("reads a single small value", () => {
		expect(decodeVlq("A")).toEqual([0]);
		expect(decodeVlq("C")).toEqual([1]);
	});

	it("reads the sign out of the low bit, not a separate field", () => {
		expect(decodeVlq("D")).toEqual([-1]);
	});

	it("reads a value that needed a continuation character", () => {
		// Six bits per character, five of payload: 22 from '2', then
		// 7 from 'H' shifted up by five, signed off the low bit.
		expect(decodeVlq("2H")).toEqual([123]);
	});

	it("reads a whole four field segment", () => {
		expect(decodeVlq("SAASA")).toEqual([9, 0, 0, 9, 0]);
	});

	it("refuses a run holding a character outside the alphabet", () => {
		// Half a segment would point somewhere confidently wrong.
		expect(decodeVlq("AB*C")).toBeUndefined();
	});

	it("refuses a run that ends mid number", () => {
		expect(decodeVlq("g")).toBeUndefined();
	});
});

describe("decodeMappings", () => {
	it("gives one entry per generated line", () => {
		expect(decodeMappings("AAAA;AACA;AACA")).toHaveLength(3);
	});

	it("keeps a line that maps nothing, so line numbers stay true", () => {
		const lines = decodeMappings("AAAA;;AACA");
		expect(lines).toHaveLength(3);
		expect(lines[1]).toEqual([]);
	});

	it("restarts the generated column each line but carries the rest", () => {
		const lines = decodeMappings("IAAIA;IACIA");
		expect(lines[0]?.[0]?.generatedColumn).toBe(4);
		// Second line starts over at 4 rather than accumulating to 8.
		expect(lines[1]?.[0]?.generatedColumn).toBe(4);
		// The source line, though, is a running total.
		expect(lines[0]?.[0]?.sourceLine).toBe(0);
		expect(lines[1]?.[0]?.sourceLine).toBe(1);
	});

	it("keeps a one field segment as generated code with no origin", () => {
		const [line] = decodeMappings("AAAA,C");
		expect(line?.[1]).toEqual({ generatedColumn: 1 });
	});

	it("decodes a real minified bundle into one long line", () => {
		const lines = decodeMappings(SCRIPT_MAP.mappings);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.length).toBeGreaterThan(10);
	});
});

describe("readSourceMap", () => {
	it("folds a source root into every source", () => {
		const map = readSourceMap({
			sources: ["a.js"],
			sourceRoot: "https://cdn/app/",
			mappings: "AAAA",
		});
		expect(map.sources[0]).toBe("https://cdn/app/a.js");
	});

	it("does not double a slash between root and source", () => {
		const map = readSourceMap({
			sources: ["/a.js"],
			sourceRoot: "https://cdn/app/",
			mappings: "AAAA",
		});
		expect(map.sources[0]).toBe("https://cdn/app/a.js");
	});

	it("names an anonymous source rather than leaving a hole", () => {
		const map = readSourceMap({ sources: [null], mappings: "AAAA" });
		expect(map.sources[0]).toBe("(anonymous)");
	});
});

describe("authoredPosition", () => {
	const map = readSourceMap(SCRIPT_MAP);

	it("resolves the throw inside the minified bundle", () => {
		// Column 32 of the single generated line is where Chrome put
		// the top frame of the thrown TypeError.
		const found = authoredPosition(map, { line: 0, column: 32 });
		expect(found?.source).toBe("src/greet.js");
		// Zero based: authored line 2 is the throw statement.
		expect(found?.line).toBe(2);
	});

	it("resolves the calling frame to the other module", () => {
		const found = authoredPosition(map, { line: 0, column: 104 });
		expect(found?.source).toBe("src/app-main.js");
	});

	it("takes the nearest mapping at or before the column", () => {
		// Nothing is mapped at exactly 33, so the answer is the
		// statement that column sits inside.
		expect(authoredPosition(map, { line: 0, column: 33 })?.line).toBe(
			authoredPosition(map, { line: 0, column: 32 })?.line,
		);
	});

	it("carries the authored name when the map recorded one", () => {
		const named = map.lines[0]?.find((s) => s.nameIndex !== undefined);
		expect(named).toBeDefined();
		const found = authoredPosition(map, {
			line: 0,
			column: named?.generatedColumn ?? 0,
		});
		expect(found?.name).toBeTruthy();
	});

	it("carries the authored text when the map embedded it", () => {
		expect(authoredPosition(map, { line: 0, column: 32 })?.content).toContain(
			"greet needs a name",
		);
	});

	it("says nothing for a line the map does not cover", () => {
		expect(authoredPosition(map, { line: 99, column: 0 })).toBeUndefined();
	});

	it("says nothing before the first mapping on a line", () => {
		const sparse = readSourceMap({ sources: ["a.js"], mappings: "IAAIA" });
		expect(authoredPosition(sparse, { line: 0, column: 0 })).toBeUndefined();
	});

	it("resolves a stylesheet position too", () => {
		const styles = readSourceMap(STYLE_MAP);
		const found = authoredPosition(styles, { line: 0, column: 7 });
		expect(found?.source).toBe("src/theme.css");
	});
});

describe("resolveMapUrl", () => {
	it("resolves a relative map against the file that named it", () => {
		expect(
			resolveMapUrl("http://localhost:8731/bundle.js", "bundle.js.map"),
		).toEqual({ kind: "fetch", url: "http://localhost:8731/bundle.js.map" });
	});

	it("resolves one that climbs out of a directory", () => {
		const found = resolveMapUrl("http://a/js/app.js", "../maps/app.js.map");
		expect(found).toEqual({ kind: "fetch", url: "http://a/maps/app.js.map" });
	});

	it("leaves an absolute map URL alone", () => {
		const found = resolveMapUrl("http://a/app.js", "http://cdn/app.js.map");
		expect(found).toEqual({ kind: "fetch", url: "http://cdn/app.js.map" });
	});

	it("reads a base64 data URL without fetching anything", () => {
		const json = '{"version":3,"sources":["a.js"],"mappings":"AAAA"}';
		const encoded = Buffer.from(json).toString("base64");
		expect(
			resolveMapUrl(
				"http://a/app.js",
				`data:application/json;base64,${encoded}`,
			),
		).toEqual({ kind: "inline", json });
	});

	it("reads a plain data URL too", () => {
		const found = resolveMapUrl(
			"http://a/app.js",
			"data:application/json,%7B%22a%22%3A1%7D",
		);
		expect(found).toEqual({ kind: "inline", json: '{"a":1}' });
	});

	it("gives up on a data URL with no payload separator", () => {
		expect(resolveMapUrl("http://a/app.js", "data:nonsense")).toBeUndefined();
	});

	it("gives up when the file has no URL to resolve against", () => {
		expect(resolveMapUrl("", "app.js.map")).toBeUndefined();
	});
});

describe("parseSourceMap", () => {
	it("reads a real map", () => {
		expect(parseSourceMap(JSON.stringify(SCRIPT_MAP))?.sources).toHaveLength(2);
	});

	it("refuses an HTML error page, which is what a 404 returns", () => {
		expect(parseSourceMap("<!doctype html><h1>Not Found</h1>")).toBeUndefined();
	});

	it("refuses JSON that is not a source map", () => {
		expect(parseSourceMap('{"hello":"world"}')).toBeUndefined();
	});
});

describe("a page-written source map URL cannot throw", () => {
	it("survives a malformed percent escape in a plain data URL", () => {
		// A sourceMappingURL is written by the page, so a stray
		// percent sign is page input. Only the base64 branch was
		// guarded, and decodeURIComponent threw a URIError straight
		// out of a function whose comment promised it would not.
		expect(() =>
			resolveMapUrl("https://x/app.js", "data:application/json,{%ZZ}"),
		).not.toThrow();
		expect(
			resolveMapUrl("https://x/app.js", "data:application/json,{%ZZ}"),
		).toBeUndefined();
	});

	it("still reads a well-formed plain data URL", () => {
		expect(
			resolveMapUrl(
				"https://x/a.js",
				"data:application/json,%7B%22version%22%3A3%7D",
			),
		).toEqual({ kind: "inline", json: '{"version":3}' });
	});
});
