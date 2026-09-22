import { describe, expect, it } from "vitest";
import { mermaidContent } from "../../extensions/mermaid-widget/content.js";

const RENDER = {
	pngPath: "/tmp/diagram.png",
	svgPath: "/tmp/diagram.svg",
	base64: "AAAABBBBCCCC".repeat(10_000),
};

describe("mermaidContent", () => {
	it("answers with paths and no image by default", () => {
		// The model authored the source. A hundred thousand tokens of
		// picture of what it just wrote, billed again on every later
		// turn, buys nothing: 69 renders cost $4,644 in rent this way.
		const content = mermaidContent(RENDER, false);

		expect(content.some((block) => block.type === "image")).toBe(false);
		expect(JSON.stringify(content)).not.toContain("AAAABBBB");
	});

	it("names both files so either can be opened on demand", () => {
		const text = mermaidContent(RENDER, false)
			.map((block) => (block.type === "text" ? block.text : ""))
			.join(" ");

		expect(text).toContain("/tmp/diagram.svg");
		expect(text).toContain("/tmp/diagram.png");
	});

	it("says how to see it, so the absence is a door and not a wall", () => {
		// Dropping the bytes is only acceptable when the way back is
		// stated. An agent left wondering spends the saving back.
		const text = mermaidContent(RENDER, false)
			.map((block) => (block.type === "text" ? block.text : ""))
			.join(" ");

		expect(text.toLowerCase()).toContain("read");
	});

	it("carries the image when the caller asks to check the layout", () => {
		const content = mermaidContent(RENDER, true);
		const image = content.find((block) => block.type === "image");

		expect(image).toBeDefined();
		expect(image?.type === "image" && image.data).toBe(RENDER.base64);
		expect(image?.type === "image" && image.mimeType).toBe("image/png");
	});

	it("still names the paths when it does carry the image", () => {
		const text = mermaidContent(RENDER, true)
			.map((block) => (block.type === "text" ? block.text : ""))
			.join(" ");

		expect(text).toContain("/tmp/diagram.svg");
	});
});
