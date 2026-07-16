/**
 * Mermaid diagram rendering.
 *
 * Renders Mermaid source to two artifacts: the vector SVG Mermaid
 * produces (crisp at any zoom, the human's readable copy) and a PNG
 * rasterized from it (the portable raster and the inline image a vision
 * model sees). The PNG is scaled to sit just under the vision-model
 * pixel cap, because sending a larger image only makes the API
 * downscale and blur the text server-side. Rendering rides the shared
 * browser lifecycle from browser.ts rather than launching its own, so
 * it inherits the same teardown.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { newPage } from "./browser.js";

/** Pinned Mermaid version, fetched once from jsDelivr. */
const MERMAID_CDN =
	"https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

/** How long to wait for the one-time Mermaid library fetch. */
const MERMAID_FETCH_TIMEOUT_MS = 15_000;

/**
 * Longest-edge cap for the rasterized PNG, in pixels. Matches the Opus
 * 4.7-plus vision budget; larger images are downscaled server-side.
 */
const PNG_MAX_LONG_EDGE = 2576;

/**
 * Total-area cap for the rasterized PNG, in pixels (~3.75 megapixels,
 * the Opus 4.7-plus budget). A squarish diagram hits this before the
 * long-edge cap; a wide one hits the long edge first.
 */
const PNG_MAX_PIXELS = 3_750_000;

/**
 * Largest factor we upscale a small diagram by. Rasterizing a vector at
 * scale keeps text crisp, but chasing the cap for a tiny diagram would
 * bloat it to no benefit, so the upscale is bounded.
 */
const PNG_MAX_UPSCALE = 4;

/** A width and height in pixels. */
interface Dimensions {
	width: number;
	height: number;
}

/**
 * Compute the raster scale for a diagram of the given intrinsic size so
 * the PNG lands as close to the pixel budget as possible without
 * crossing the long-edge or total-area cap. A diagram already larger
 * than the cap is scaled down to fit; a smaller one is scaled up to the
 * upscale ceiling so its text stays crisp.
 */
export function pngRenderScale({ width, height }: Dimensions): number {
	if (width <= 0 || height <= 0) return 1;
	const edgeScale = PNG_MAX_LONG_EDGE / Math.max(width, height);
	const areaScale = Math.sqrt(PNG_MAX_PIXELS / (width * height));
	const capScale = Math.min(edgeScale, areaScale);
	if (capScale < 1) return capScale;
	return Math.min(capScale, PNG_MAX_UPSCALE);
}

/**
 * Final integer PNG dimensions for a diagram of the given intrinsic
 * size. The continuous scale is chosen so the unrounded box fits the
 * budget; flooring to whole pixels can only shrink it, so the returned
 * dimensions never cross the long-edge or total-area cap even after
 * integerization (which independent rounding would not guarantee).
 */
export function pngPixelSize({ width, height }: Dimensions): Dimensions {
	const scale = pngRenderScale({ width, height });
	return {
		width: Math.max(1, Math.floor(width * scale)),
		height: Math.max(1, Math.floor(height * scale)),
	};
}

/** The Mermaid library source, fetched once and reused per process. */
let cachedMermaidSource: string | undefined;

/**
 * Fetch the Mermaid library source once, in Node, and cache it.
 * Injecting the cached content into the render page means the page
 * itself does no network work mid-render, which is what made
 * rendering hang under a busy shared browser.
 */
export async function loadMermaidSource(
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	if (cachedMermaidSource) return cachedMermaidSource;
	let response: Response;
	try {
		response = await fetchImpl(MERMAID_CDN, {
			signal: AbortSignal.timeout(MERMAID_FETCH_TIMEOUT_MS),
		});
	} catch {
		throw new MermaidRenderError(
			"Could not fetch the Mermaid library (network required). " +
				"Rendering needs internet access to fetch Mermaid.",
		);
	}
	if (!response.ok) {
		throw new MermaidRenderError(
			`Could not fetch the Mermaid library (HTTP ${response.status}).`,
		);
	}
	cachedMermaidSource = await response.text();
	return cachedMermaidSource;
}

/** Thrown when Mermaid source cannot be rendered (bad syntax or no library). */
export class MermaidRenderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MermaidRenderError";
	}
}

/** A rendered Mermaid diagram. */
export interface MermaidRender {
	/** Path to the PNG file on disk (the caller's path, or a temp path). */
	pngPath: string;
	/** Path to the SVG file on disk, beside the PNG (crisp at any zoom). */
	svgPath: string;
	/** Base64 PNG, for returning to a vision model inline. */
	base64: string;
	/** Final PNG width in pixels, after scaling to the cap. */
	width: number;
	/** Final PNG height in pixels, after scaling to the cap. */
	height: number;
}

/** Default output path for a rendered diagram when the caller gives none. */
function defaultOutputPath(): string {
	const id = crypto.randomBytes(6).toString("hex");
	const dir = path.join(os.tmpdir(), "pi-mermaid");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${id}.png`);
}

/** Sibling SVG path for a PNG output path, sharing the base name. */
function svgPathFor(pngPath: string): string {
	const parsed = path.parse(pngPath);
	return path.join(parsed.dir, `${parsed.name}.svg`);
}

/** True when a value is a finite number greater than zero. */
function isPositiveFinite(n: number | undefined): n is number {
	return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** What the render page reports back: the SVG string and its size, or an error. */
interface RenderedSvg {
	svg?: string;
	width?: number;
	height?: number;
	error?: string;
}

/**
 * Render Mermaid source to an SVG and a PNG on disk and return their
 * paths plus a base64 copy of the PNG and its final dimensions. The SVG
 * is the vector artifact (crisp at any zoom); the PNG is rasterized from
 * it, scaled toward the vision-model pixel budget (up to an upscale
 * ceiling) without crossing it. The output path must name the PNG; the
 * SVG is written beside it with the same base name. Reuses the shared
 * headless browser. Throws MermaidRenderError when the library cannot
 * load, the path is not a PNG, or the source is invalid.
 */
export async function renderMermaid(
	source: string,
	outputPath?: string,
): Promise<MermaidRender> {
	const pngPath = outputPath ?? defaultOutputPath();
	if (!pngPath.toLowerCase().endsWith(".png")) {
		throw new MermaidRenderError(
			"render_mermaid output path must end in .png; the SVG is " +
				"written beside it with the same base name.",
		);
	}
	const svgPath = svgPathFor(pngPath);
	const page = await newPage();
	try {
		await page.setContent(
			'<!doctype html><html><body style="margin:0;background:#ffffff">' +
				'<div id="container"></div></body></html>',
		);

		const mermaidSource = await loadMermaidSource();
		try {
			await page.addScriptTag({ content: mermaidSource });
		} catch {
			throw new MermaidRenderError(
				"Could not load the Mermaid library into the render page.",
			);
		}

		const rendered: RenderedSvg = await page.evaluate(async (src) => {
			// biome-ignore lint/suspicious/noExplicitAny: window.mermaid is injected at runtime.
			const mermaid = (window as any).mermaid;
			if (!mermaid) return { error: "Mermaid library did not initialize." };
			mermaid.initialize({ startOnLoad: false, theme: "default" });
			try {
				const { svg } = await mermaid.render("pi-diagram", src);
				const container = document.getElementById("container");
				if (!container) return { error: "Render container missing." };
				container.innerHTML = svg;
				const el = container.querySelector("svg");
				if (!(el instanceof SVGSVGElement)) {
					return { error: "Mermaid produced no SVG output." };
				}
				// Prefer the viewBox for the true intrinsic size; a Mermaid SVG
				// carries width:100% and a max-width, so its bounding box can be
				// clamped to the viewport rather than its natural size.
				const vb = el.viewBox.baseVal;
				let width = vb.width;
				let height = vb.height;
				if (!width || !height) {
					const box = el.getBoundingClientRect();
					width = box.width;
					height = box.height;
				}
				return { svg, width, height };
			} catch (e) {
				return { error: e instanceof Error ? e.message : String(e) };
			}
		}, source);

		if (rendered.error || !rendered.svg) {
			throw new MermaidRenderError(
				`Mermaid could not render the diagram: ${
					rendered.error ?? "no SVG output"
				}`,
			);
		}

		const intrinsicWidth = rendered.width;
		const intrinsicHeight = rendered.height;
		if (
			!isPositiveFinite(intrinsicWidth) ||
			!isPositiveFinite(intrinsicHeight)
		) {
			throw new MermaidRenderError(
				"Mermaid produced a diagram with no measurable size.",
			);
		}

		// Size the PNG toward the vision-model budget, then pin the SVG to
		// those pixels and drop its max-width so the capture is not clamped
		// to the viewport.
		const { width, height } = pngPixelSize({
			width: intrinsicWidth,
			height: intrinsicHeight,
		});
		await page.setViewport({ width, height, deviceScaleFactor: 1 });
		await page.evaluate(
			(w, h) => {
				const el = document.querySelector("#container svg");
				if (!(el instanceof SVGElement)) return;
				el.setAttribute("width", String(w));
				el.setAttribute("height", String(h));
				el.style.maxWidth = "none";
			},
			width,
			height,
		);

		const element = await page.$("#container svg");
		if (!element) {
			throw new MermaidRenderError("Mermaid produced no SVG output.");
		}

		const shot = await element.screenshot({ type: "png", encoding: "base64" });
		const base64 =
			typeof shot === "string" ? shot : Buffer.from(shot).toString("base64");

		// Commit both artifacts only after a successful capture, so a mid-
		// render failure never leaves a stray or half-written file on disk.
		fs.mkdirSync(path.dirname(pngPath), { recursive: true });
		fs.mkdirSync(path.dirname(svgPath), { recursive: true });
		fs.writeFileSync(svgPath, rendered.svg, "utf8");
		fs.writeFileSync(pngPath, Buffer.from(base64, "base64"));
		return { pngPath, svgPath, base64, width, height };
	} finally {
		await page.close();
	}
}
