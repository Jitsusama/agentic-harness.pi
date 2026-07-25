import { describe, expect, it } from "vitest";
import {
	normalizeCascade,
	type RawMatchedStyles,
	traceProperty,
} from "../../../../lib/web/styles/index.js";

/**
 * A capture shaped the way Chrome returns it for the cascade
 * fixture: a div carrying class card wide muted, id hero and an
 * inline padding, inside a body that sets colour and font size.
 *
 * Chrome hands the rules back weakest first, having already
 * done the specificity, media and matching work.
 */
const CAPTURE: RawMatchedStyles = {
	inlineStyle: {
		cssProperties: [{ name: "padding", value: "20px", text: "padding: 20px" }],
	},
	matchedCSSRules: [
		{
			rule: {
				origin: "user-agent",
				selectorList: { text: "div" },
				style: {
					cssProperties: [
						{ name: "display", value: "block", text: "display: block" },
					],
				},
			},
		},
		{
			rule: {
				origin: "regular",
				selectorList: { text: ".card" },
				styleSheetId: "sheet-1",
				style: {
					cssProperties: [
						{
							name: "color",
							value: "navy",
							text: "color: navy",
							range: { startLine: 2, startColumn: 24 },
						},
						{
							name: "font-size",
							value: "14px",
							text: "font-size: 14px",
							range: { startLine: 2, startColumn: 37 },
						},
					],
				},
			},
		},
		{
			rule: {
				origin: "regular",
				selectorList: { text: ".muted" },
				styleSheetId: "sheet-1",
				style: {
					cssProperties: [
						{
							name: "color",
							value: "gray",
							text: "color: gray !important",
							important: true,
							range: { startLine: 5, startColumn: 11 },
						},
					],
				},
			},
		},
		{
			rule: {
				origin: "regular",
				selectorList: { text: ".card" },
				styleSheetId: "sheet-1",
				media: [{ text: "(min-width: 100px)" }],
				style: {
					cssProperties: [
						{
							name: "font-size",
							value: "15px",
							text: "font-size: 15px",
							range: { startLine: 6, startColumn: 38 },
						},
					],
				},
			},
		},
		{
			rule: {
				origin: "regular",
				selectorList: { text: "#hero" },
				styleSheetId: "sheet-1",
				style: {
					cssProperties: [
						{
							name: "color",
							value: "rebeccapurple",
							text: "color: rebeccapurple",
							range: { startLine: 4, startColumn: 10 },
						},
					],
				},
			},
		},
	],
	inherited: [
		{
			matchedCSSRules: [
				{
					rule: {
						origin: "regular",
						selectorList: { text: "body" },
						styleSheetId: "sheet-1",
						style: {
							cssProperties: [
								{
									name: "color",
									value: "#222",
									text: "color: #222",
								},
							],
						},
					},
				},
			],
		},
	],
};

describe("normalizeCascade", () => {
	it("keeps the order the browser handed back", () => {
		// Chrome sorts by specificity and document order already.
		// Re-sorting here would be reimplementing the cascade.
		const declarations = normalizeCascade(CAPTURE);
		const colours = declarations
			.filter((d) => d.property === "color" && d.origin === "author")
			.map((d) => d.value);
		expect(colours).toEqual(["navy", "gray", "rebeccapurple"]);
	});

	it("records where a declaration was written", () => {
		const [muted] = normalizeCascade(CAPTURE).filter(
			(d) => d.selector === ".muted",
		);
		expect(muted).toMatchObject({
			property: "color",
			value: "gray",
			important: true,
			origin: "author",
			selector: ".muted",
			source: { styleSheet: "sheet-1", line: 5, column: 11 },
		});
	});

	it("tells an inline declaration apart from a rule", () => {
		const inline = normalizeCascade(CAPTURE).filter(
			(d) => d.origin === "inline",
		);
		expect(inline).toEqual([
			{
				property: "padding",
				value: "20px",
				important: false,
				origin: "inline",
			},
		]);
	});

	it("tells a browser default apart from something authored", () => {
		const ua = normalizeCascade(CAPTURE).filter(
			(d) => d.origin === "user-agent",
		);
		expect(ua.map((d) => d.property)).toEqual(["display"]);
	});

	it("carries the media query a rule was written under", () => {
		const [scoped] = normalizeCascade(CAPTURE).filter(
			(d) => d.property === "font-size" && d.value === "15px",
		);
		expect(scoped.media).toEqual(["(min-width: 100px)"]);
	});

	it("marks an inherited declaration as inherited", () => {
		const inherited = normalizeCascade(CAPTURE).filter(
			(d) => d.origin === "inherited",
		);
		expect(inherited).toMatchObject([
			{ property: "color", value: "#222", selector: "body" },
		]);
	});

	it("reports a side the shorthand set, naming the shorthand", () => {
		// Asking why padding-top is 8px has to reach the rule that
		// said padding: 8px, or the trace comes back empty for a
		// property something plainly set.
		const declarations = normalizeCascade({
			matchedCSSRules: [
				{
					rule: {
						origin: "regular",
						selectorList: { text: ".x" },
						style: {
							cssProperties: [
								{
									name: "margin",
									value: "1px",
									text: "margin: 1px",
									longhandProperties: [{ name: "margin-top", value: "1px" }],
								},
								{ name: "margin-top", value: "1px" },
							],
						},
					},
				},
			],
		});
		expect(declarations).toMatchObject([
			{ property: "margin", value: "1px", selector: ".x" },
			{ property: "margin-top", value: "1px", via: "margin" },
		]);
	});

	it("reads a browser default even with no source text", () => {
		// A user-agent rule reports only names and values. Treating
		// the missing text as "nobody wrote this" hid every browser
		// default, so display traced back to nothing at all.
		const declarations = normalizeCascade({
			matchedCSSRules: [
				{
					rule: {
						origin: "user-agent",
						selectorList: { text: "div" },
						style: {
							cssProperties: [{ name: "display", value: "block" }],
						},
					},
				},
			],
		});
		expect(declarations).toMatchObject([
			{ property: "display", value: "block", origin: "user-agent" },
		]);
	});

	it("keeps the authored form when a rule restates a property", () => {
		// A rule reports its authored declarations and then the full
		// longhand set, so the same name arrives twice. The authored
		// one is the one that can say where it was written.
		const declarations = normalizeCascade({
			matchedCSSRules: [
				{
					rule: {
						origin: "regular",
						selectorList: { text: ".x" },
						styleSheetId: "sheet-1",
						style: {
							cssProperties: [
								{
									name: "color",
									value: "navy",
									text: "color: navy",
									range: { startLine: 2, startColumn: 24 },
								},
								{ name: "color", value: "navy" },
							],
						},
					},
				},
			],
		});
		expect(declarations).toHaveLength(1);
		expect(declarations[0].source).toEqual({
			styleSheet: "sheet-1",
			line: 2,
			column: 24,
		});
	});

	it("leaves out a declaration the author switched off", () => {
		const declarations = normalizeCascade({
			matchedCSSRules: [
				{
					rule: {
						origin: "regular",
						selectorList: { text: ".x" },
						style: {
							cssProperties: [
								{
									name: "color",
									value: "navy",
									text: "color: navy",
									disabled: true,
								},
							],
						},
					},
				},
			],
		});
		expect(declarations).toEqual([]);
	});

	it("states importance once, as a flag and not in the value", () => {
		// The capture reports the token in the value as well as in
		// the flag, which reads back as "gray !important !important".
		const [declaration] = normalizeCascade({
			matchedCSSRules: [
				{
					rule: {
						origin: "regular",
						selectorList: { text: ".muted" },
						style: {
							cssProperties: [
								{
									name: "color",
									value: "gray !important",
									text: "color: gray !important",
									important: true,
								},
							],
						},
					},
				},
			],
		});
		expect(declaration).toMatchObject({ value: "gray", important: true });
	});

	it("leaves a value alone that merely mentions important", () => {
		const [declaration] = normalizeCascade({
			matchedCSSRules: [
				{
					rule: {
						origin: "regular",
						selectorList: { text: ".x" },
						style: {
							cssProperties: [
								{
									name: "content",
									value: '"!important"',
									text: 'content: "!important"',
								},
							],
						},
					},
				},
			],
		});
		expect(declaration.value).toBe('"!important"');
	});

	it("treats an empty media list as no media at all", () => {
		// The protocol reports media as an empty array on an
		// ordinary rule, which reads as a media query if believed.
		const [declaration] = normalizeCascade({
			matchedCSSRules: [
				{
					rule: {
						origin: "regular",
						selectorList: { text: ".x" },
						media: [],
						style: {
							cssProperties: [
								{ name: "color", value: "navy", text: "color: navy" },
							],
						},
					},
				},
			],
		});
		expect(declaration.media).toBeUndefined();
	});
});

describe("traceProperty", () => {
	it("puts the strongest declaration first", () => {
		const trace = traceProperty(normalizeCascade(CAPTURE), "color");
		expect(trace.declarations.map((d) => d.value)).toEqual([
			"gray",
			"rebeccapurple",
			"navy",
			"#222",
		]);
	});

	it("marks the important declaration as the winner", () => {
		// It sits in a weak position in the browser's ordering, so
		// the reading has to account for importance itself. This
		// is the one cascade rule the protocol leaves to us.
		const trace = traceProperty(normalizeCascade(CAPTURE), "color");
		expect(trace.winner).toMatchObject({ value: "gray", selector: ".muted" });
	});

	it("lets an inline declaration beat a rule", () => {
		const trace = traceProperty(normalizeCascade(CAPTURE), "padding");
		expect(trace.winner).toMatchObject({ value: "20px", origin: "inline" });
	});

	it("takes the last of equal-weight declarations", () => {
		const trace = traceProperty(normalizeCascade(CAPTURE), "font-size");
		expect(trace.winner).toMatchObject({ value: "15px" });
	});

	it("prefers anything authored over a browser default", () => {
		const trace = traceProperty(
			normalizeCascade({
				matchedCSSRules: [
					{
						rule: {
							origin: "user-agent",
							selectorList: { text: "div" },
							style: {
								cssProperties: [
									{ name: "display", value: "block", text: "display: block" },
								],
							},
						},
					},
					{
						rule: {
							origin: "regular",
							selectorList: { text: ".x" },
							style: {
								cssProperties: [
									{ name: "display", value: "flex", text: "display: flex" },
								],
							},
						},
					},
				],
			}),
			"display",
		);
		expect(trace.winner).toMatchObject({ value: "flex", origin: "author" });
	});

	it("prefers an own declaration over an inherited one", () => {
		const trace = traceProperty(normalizeCascade(CAPTURE), "color");
		expect(trace.winner?.origin).not.toBe("inherited");
	});

	it("falls back to what was inherited when nothing else applies", () => {
		const trace = traceProperty(
			normalizeCascade({
				inherited: [
					{
						matchedCSSRules: [
							{
								rule: {
									origin: "regular",
									selectorList: { text: "body" },
									style: {
										cssProperties: [
											{
												name: "font-family",
												value: "Georgia",
												text: "font-family: Georgia",
											},
										],
									},
								},
							},
						],
					},
				],
			}),
			"font-family",
		);
		expect(trace.winner).toMatchObject({ value: "Georgia" });
	});

	it("carries the computed value so the reader can check the working", () => {
		const trace = traceProperty(
			normalizeCascade(CAPTURE),
			"color",
			"rgb(128, 128, 128)",
		);
		expect(trace.computed).toBe("rgb(128, 128, 128)");
	});

	it("says plainly when nothing declared the property", () => {
		const trace = traceProperty(normalizeCascade(CAPTURE), "z-index");
		expect(trace.declarations).toEqual([]);
		expect(trace.winner).toBeUndefined();
	});
});
