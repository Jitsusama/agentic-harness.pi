/**
 * Mermaid diagram rendering.
 *
 * Renders Mermaid source to a PNG by loading the Mermaid library in the
 * shared headless browser, rendering to SVG, and rasterizing the SVG
 * element. Rendering rides the shared browser lifecycle from browser.ts
 * rather than launching its own, so it inherits the same teardown.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { newPage } from "./browser.js";

/** Pinned Mermaid version, loaded into the render page from jsDelivr. */
const MERMAID_CDN =
	"https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

/** Thrown when Mermaid source cannot be rendered (bad syntax or no library). */
export class MermaidRenderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MermaidRenderError";
	}
}

/** A rendered Mermaid diagram. */
export interface MermaidRender {
	/** Absolute path to the PNG file on disk. */
	pngPath: string;
	/** Base64 PNG, for returning to a vision model inline. */
	base64: string;
}

/** Default output path for a rendered diagram when the caller gives none. */
function defaultOutputPath(): string {
	const id = crypto.randomBytes(6).toString("hex");
	const dir = path.join(os.tmpdir(), "pi-mermaid");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${id}.png`);
}

/**
 * Render Mermaid source to a PNG file and return its path plus a base64
 * copy. Reuses the shared headless browser. Throws MermaidRenderError
 * when the library cannot load or the source is invalid.
 */
export async function renderMermaid(
	source: string,
	outputPath?: string,
): Promise<MermaidRender> {
	const pngPath = outputPath ?? defaultOutputPath();
	const page = await newPage();
	try {
		await page.setContent(
			'<!doctype html><html><body style="margin:0;background:#ffffff">' +
				'<div id="container"></div></body></html>',
		);

		try {
			await page.addScriptTag({ url: MERMAID_CDN });
		} catch {
			throw new MermaidRenderError(
				"Could not load the Mermaid library (network required). " +
					"Rendering needs internet access to fetch Mermaid.",
			);
		}

		const error = await page.evaluate(async (src) => {
			// biome-ignore lint/suspicious/noExplicitAny: window.mermaid is injected at runtime.
			const mermaid = (window as any).mermaid;
			if (!mermaid) return "Mermaid library did not initialize.";
			mermaid.initialize({ startOnLoad: false, theme: "default" });
			try {
				const { svg } = await mermaid.render("pi-diagram", src);
				const container = document.getElementById("container");
				if (container) container.innerHTML = svg;
				return null;
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			}
		}, source);

		if (error) {
			throw new MermaidRenderError(
				`Mermaid could not render the diagram: ${error}`,
			);
		}

		const element = await page.$("#container svg");
		if (!element) {
			throw new MermaidRenderError("Mermaid produced no SVG output.");
		}

		const shot = await element.screenshot({ type: "png", encoding: "base64" });
		const base64 =
			typeof shot === "string" ? shot : Buffer.from(shot).toString("base64");
		fs.mkdirSync(path.dirname(pngPath), { recursive: true });
		fs.writeFileSync(pngPath, Buffer.from(base64, "base64"));
		return { pngPath, base64 };
	} finally {
		await page.close();
	}
}
