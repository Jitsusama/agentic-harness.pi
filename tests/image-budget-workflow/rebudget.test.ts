import type { TextContent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { PIXEL_BUDGET } from "../../extensions/image-budget-workflow/budget.js";
import {
	type Block,
	type Resize,
	type Resized,
	rebudget,
} from "../../extensions/image-budget-workflow/rebudget.js";

/**
 * A square comfortably inside the allowance, whatever it is set to.
 * Sizing against the allowance rather than in absolute pixels means
 * tuning it does not turn these into failures about nothing.
 */
const SMALL = Math.floor(Math.sqrt(PIXEL_BUDGET / 2));

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
		const out = await rebudget([image], resizerFor(SMALL, SMALL));

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
		expect(String(note?.text)).toContain("Multiply coordinates");
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

	it("budgets from pi's reported original, not the payload it shrank", async () => {
		// pi resizes 3024x1964 down to 2000x1299 before this runs. A
		// budget computed from 2000x1299 is a budget against an
		// intermediate, and the note it produces describes the wrong scale.
		const piNote: Block = {
			type: "text",
			text:
				"[Image: original 3024x1964, displayed at 2000x1299. " +
				"Multiply coordinates by 1.51 to map to original image.]",
		};
		const out = await rebudget([image, piNote], resizerFor(2000, 1299));
		const blocks = out.content ?? [];

		// One note out, not two, and it names the true original.
		const prose = blocks.filter((b): b is TextContent => b.type === "text");
		expect(prose).toHaveLength(1);
		expect(prose[0].text).toContain("3024x1964");
		expect(prose[0].text).not.toContain("1.51");
	});

	it("re-encodes from the original file when one is available", async () => {
		// Resizing the payload stacks a second compression on pi's. Given
		// the bytes on disk, there is only ever one.
		const seen: string[] = [];
		const watching: Resize = async (bytes, mimeType, options) => {
			seen.push(Buffer.from(bytes).toString("utf8").slice(0, 8));
			return resizerFor(3024, 1964)(bytes, mimeType, options);
		};
		const piNote: Block = {
			type: "text",
			text: "[Image: original 3024x1964, displayed at 2000x1299. x]",
		};

		await rebudget([image, piNote], watching, async () =>
			Buffer.from("fromdisk"),
		);

		expect(seen.every((s) => s === "fromdisk")).toBe(true);
	});

	it("finds pi's note where pi actually puts it, before the image", async () => {
		// pi writes the note ahead of the image and folds it into the same
		// block as the tool's own first line. Looking beside the image
		// missed it entirely and left a stale factor above an accurate one.
		const lead: Block = {
			type: "text",
			text:
				"Read image file [image/png]\n" +
				"[Image: original 3024x1964, displayed at 2000x1299. " +
				"Multiply coordinates by 1.51 to map to original image.]",
		};
		const out = await rebudget([lead, image], resizerFor(3024, 1964));
		const blocks = out.content ?? [];
		const prose = blocks.filter((b): b is TextContent => b.type === "text");

		// The tool's own line survives; pi's note does not; one note added.
		expect(prose).toHaveLength(2);
		expect(prose[0].text).toBe("Read image file [image/png]");
		expect(prose[1].text).toContain("3024x1964");
		expect(
			blocks.some((b) => b.type === "text" && b.text.includes("1.51")),
		).toBe(false);
	});

	it("puts pi's note back when it scaled nothing after all", async () => {
		// A note lifted out and an image left alone must not end with the
		// note gone: that would hide what pi said about the picture.
		const lead: Block = {
			type: "text",
			text: `[Image: original ${SMALL}x${SMALL}, displayed at ${SMALL}x${SMALL}. x]`,
		};
		const out = await rebudget([lead, image], resizerFor(SMALL, SMALL));

		expect(out.content).toBeNull();
	});

	it("handles several images in one result", async () => {
		const out = await rebudget([image, image, image], resizerFor(2858, 1428));

		expect((out.content ?? []).filter((b) => b.type === "image")).toHaveLength(
			3,
		);
		expect(out.saved).toBeGreaterThan(9000);
	});
});
