/**
 * What a read's screenshot tiles show of a page taller than one tile.
 *
 * Tiles are taken by scrolling each band into the viewport, because
 * capturing beyond it had Chrome paint the whole document for every
 * tile: a minute a tile on a long article, which ran a read past its
 * wall. Scrolling is only correct if the pictures come out as a
 * capture of the whole page drew them, so that is what is checked, in
 * pixels: every part of the page is in some tile, and whatever the
 * viewport pins or drags along is drawn once, where the page put it.
 */

import fs from "node:fs";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeBrowser, newPage } from "../../../lib/core/web/browser.ts";
import { readPage } from "../../../lib/core/web/reader.ts";
import { captureTiles, preparePage } from "../../../lib/core/web/screenshot.ts";
import { type Fixture, haveChrome, page, serve } from "./_harness.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Stripes of 100 pixels, each a colour that says which one it is. */
const STRIPES = 40;
const STRIPE_GREEN_STEP = 5;
const STRIPE_BLUE = 128;

/** The stripe a stripe's colour names, if it is one. */
function stripeOf(r: number, g: number, b: number): number | undefined {
	if (r !== 0 || b !== STRIPE_BLUE || g % STRIPE_GREEN_STEP !== 0) {
		return undefined;
	}
	return g / STRIPE_GREEN_STEP;
}

/** Everything that is not a stripe, by the colour it is painted. */
const MARKERS = {
	header: [255, 0, 0],
	banner: [255, 255, 0],
	stickyBar: [255, 0, 255],
	stickyFoot: [0, 255, 255],
} as const;

type Marker = keyof typeof MARKERS;

function stripe(index: number): string {
	const green = index * STRIPE_GREEN_STEP;
	return `<div style="height:100px;background:rgb(0,${green},${STRIPE_BLUE})"></div>`;
}

function block(style: string, [r, g, b]: readonly number[]): string {
	return `<div style="${style};background:rgb(${r},${g},${b})"></div>`;
}

/**
 * A page three tiles tall carrying each kind of element that scrolling
 * could draw more than once: a fixed header and a fixed cookie banner,
 * a bar that sticks to the top once it is reached, and a footer that
 * sticks to the bottom until it is reached.
 */
const TALL = page(
	"Tall",
	[
		"<style>body{margin:0}</style>",
		...Array.from({ length: 3 }, (_, i) => stripe(i)),
		block("position:sticky;top:0;height:30px", MARKERS.stickyBar),
		...Array.from({ length: STRIPES - 3 }, (_, i) => stripe(i + 3)),
		block("position:sticky;bottom:0;height:30px", MARKERS.stickyFoot),
		block("position:fixed;top:0;left:0;right:0;height:40px", MARKERS.header),
		block("position:fixed;bottom:0;left:0;right:0;height:60px", MARKERS.banner),
	].join(""),
);

/** How often down a tile to look, in pixels. */
const SAMPLE_STEP = 5;
const SAMPLE_X = 640;

/** What one tile shows down its middle. */
interface TileReading {
	readonly stripes: ReadonlySet<number>;
	readonly markers: ReadonlySet<Marker>;
}

function readTile(file: string): TileReading {
	const png = PNG.sync.read(fs.readFileSync(file));
	const stripes = new Set<number>();
	const markers = new Set<Marker>();
	for (let y = 0; y < png.height; y += SAMPLE_STEP) {
		const at = (png.width * y + SAMPLE_X) * 4;
		const [r, g, b] = [png.data[at], png.data[at + 1], png.data[at + 2]];
		const index = stripeOf(r, g, b);
		if (index !== undefined) stripes.add(index);
		for (const [name, colour] of Object.entries(MARKERS)) {
			if (colour[0] === r && colour[1] === g && colour[2] === b) {
				markers.add(name as Marker);
			}
		}
	}
	return { stripes, markers };
}

/** The tiles, by index, that drew a marker. */
function drawnIn(tiles: readonly TileReading[], marker: Marker): number[] {
	return tiles.flatMap((tile, index) =>
		tile.markers.has(marker) ? [index] : [],
	);
}

let fixture: Fixture;

describe.skipIf(!haveChrome)("screenshot tiles of a tall page", () => {
	let tiles: TileReading[];

	beforeAll(async () => {
		fixture = await serve([{ path: "/tall", body: TALL }]);
		const bundle = await readPage(fixture.url("/tall"));
		tiles = bundle.screenshotPaths.map(readTile);
	});

	afterAll(async () => {
		await closeBrowser();
		await fixture?.close();
	});

	it("shows every part of the page in some tile", () => {
		const seen = new Set(tiles.flatMap((tile) => [...tile.stripes]));

		expect(tiles).toHaveLength(3);
		expect(
			Array.from({ length: STRIPES }, (_, i) => i).filter((i) => !seen.has(i)),
		).toEqual([]);
	});

	it("draws what the viewport pins in the first tile only", () => {
		expect(drawnIn(tiles, "header")).toEqual([0]);
		expect(drawnIn(tiles, "banner")).toEqual([0]);
	});

	it("draws what sticks where the page puts it, once", () => {
		expect(drawnIn(tiles, "stickyBar")).toEqual([0]);
		expect(drawnIn(tiles, "stickyFoot")).toEqual([tiles.length - 1]);
	});

	it("takes every tile inside the viewport", async () => {
		// The pictures above would come out the same captured beyond
		// the viewport, and that is the capture that cost a minute a
		// tile, so the option is held here directly.
		const tab = await newPage();
		try {
			const asked: unknown[] = [];
			const screenshot = tab.screenshot.bind(tab);
			tab.screenshot = ((options: Parameters<typeof screenshot>[0]) => {
				asked.push(options?.captureBeyondViewport);
				return screenshot(options);
			}) as typeof tab.screenshot;
			await tab.goto(fixture.url("/tall"));
			await preparePage(tab);

			await captureTiles(tab);

			expect(asked).toEqual([false, false, false]);
		} finally {
			await tab.close();
		}
	});
});
