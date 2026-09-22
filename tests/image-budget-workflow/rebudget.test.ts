import type { TextContent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type Block,
	type Resize,
	type Resized,
	rebudget,
} from "../../extensions/image-budget-workflow/rebudget.js";

/** A resizer that reports a fixed original size and honours the request. */
function resizerFor(width: number, height: number, ok = true): Resize {
	return async (_bytes, mimeType, options) => {
		if (!ok) return null;
		const ratio = Math.min(
			1,
			options.maxWidth / width,
			options.maxHeight / height,
		);
		const out: Resized = {
			data: "resized-payload",
			mimeType,
			originalWidth: width,
			originalHeight: height,
			width: Math.floor(width * ratio),
			height: Math.floor(height * ratio),
			wasResized: ratio < 1,
		};
		return out;
	};
}

const image: Block = {
	type: "image",
	data: Buffer.from("original").toString("base64"),
	mimeType: "image/png",
};
const text: Block = { type: "text", text: "some prose" };

describe("rebudget", () => {
	it("leaves a result with no images completely alone", async () => {
		const out = await rebudget([text], resizerFor(4000, 4000));

		expect(out.content).toBeNull();
		expect(out.saved).toBe(0);
	});

	it("leaves an image already within the allowance alone", async () => {
		// Null content means untouched: no re-encode, no second
		// compression, no worker time spent for nothing.
		const out = await rebudget([image], resizerFor(1429, 714));

		expect(out.content).toBeNull();
		expect(out.saved).toBe(0);
	});

	it("scales an oversized image and reports what it saved", async () => {
		const out = await rebudget([image], resizerFor(2858, 1428));

		expect(out.content).not.toBeNull();
		expect(out.saved).toBeGreaterThan(3000);
		const images = (out.content ?? []).filter((b) => b.type === "image");
		expect(images).toHaveLength(1);
		expect(images[0].data).toBe("resized-payload");
	});

	it("says what it scaled, so coordinates still map", async () => {
		const out = await rebudget([image], resizerFor(2858, 1428));
		const note = (out.content ?? []).find((b) => b.type === "text");

		expect(note).toBeDefined();
		expect(String(note?.text)).toContain("2858x1428");
		expect(String(note?.text)).toContain("Coordinates");
	});

	it("keeps the original when the resizer cannot decode it", async () => {
		// An image the model cannot see is worse than one that costs too
		// much, so every failure path keeps the picture.
		const out = await rebudget([image], resizerFor(2858, 1428, false));

		expect(out.content).toBeNull();
		expect(out.saved).toBe(0);
	});

	it("preserves the order of everything around an image", async () => {
		const before: Block = { type: "text", text: "before" };
		const after: Block = { type: "text", text: "after" };
		const out = await rebudget([before, image, after], resizerFor(2858, 1428));

		const blocks = out.content ?? [];
		expect(blocks.map((b) => b.type)).toEqual([
			"text",
			"image",
			"text",
			"text",
		]);
		const prose = blocks.filter((b): b is TextContent => b.type === "text");
		expect(prose[0].text).toBe("before");
		expect(prose.at(-1)?.text).toBe("after");
	});

	it("handles several images in one result", async () => {
		const out = await rebudget([image, image, image], resizerFor(2858, 1428));

		expect((out.content ?? []).filter((b) => b.type === "image")).toHaveLength(
			3,
		);
		expect(out.saved).toBeGreaterThan(9000);
	});
});
