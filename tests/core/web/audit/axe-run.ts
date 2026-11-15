/**
 * An axe run to read, lifted verbatim from a real axe 4.12 run
 * against a deliberately broken page, tag lists and all, rather
 * than shortened to what the code happens to look at.
 */

import type { RawAxeRun } from "../../../../lib/core/web/audit/axe.ts";

/** An axe run against a page with a dozen planted faults. */
export const RUN: RawAxeRun = {
	violations: [
		{
			id: "image-alt",
			impact: "critical",
			tags: ["cat.text-alternatives", "wcag2a", "wcag111", "EN-301-549"],
			description: "Ensure <img> elements have alternate text",
			help: "Images must have alternative text",
			helpUrl: "https://dequeuniversity.com/rules/axe/4.12/image-alt",
			nodes: [
				{
					html: '<img src="/logo.png">',
					target: ["img"],
					impact: "critical",
					any: [{ message: "Element does not have an alt attribute" }],
					all: [],
					none: [],
				},
			],
		},
		{
			id: "color-contrast",
			impact: "serious",
			tags: ["cat.color", "wcag2aa", "wcag143"],
			help: "Elements must meet minimum colour contrast ratio thresholds",
			nodes: [
				{
					html: '<p class="faint">Faint text nobody can read</p>',
					target: [".faint"],
					any: [
						{
							message:
								"Element has insufficient colour contrast of 1.62 (foreground #bbbbbb, background #ffffff)",
						},
					],
				},
			],
		},
		{
			id: "heading-order",
			impact: "moderate",
			tags: ["cat.semantics", "best-practice"],
			help: "Heading levels should only increase by one",
			nodes: [{ html: "<h4>Skipped two levels</h4>", target: ["h4"], any: [] }],
		},
		{
			id: "region",
			impact: "moderate",
			tags: ["cat.keyboard", "best-practice"],
			help: "All page content should be contained by landmarks",
			nodes: Array.from({ length: 9 }, (_, index) => ({
				html: `<p>block ${index}</p>`,
				target: [`p:nth-child(${index + 1})`],
				any: [{ message: "Some page content is not contained by landmarks" }],
			})),
		},
	],
	incomplete: [
		{
			id: "color-contrast",
			impact: "serious",
			tags: ["cat.color", "wcag2aa", "wcag143"],
			help: "Elements must meet minimum colour contrast ratio thresholds",
			nodes: [
				{
					html: '<p class="grad">Text over a gradient</p>',
					target: [".grad"],
					any: [
						{
							message:
								"Element's background colour could not be determined due to a background gradient",
						},
					],
				},
			],
		},
	],
};
