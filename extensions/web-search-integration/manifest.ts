/**
 * Manifest formatting for web_read.
 *
 * Turns a captured PageBundle into the compact pointer list the tool
 * returns, so the model opens exactly the representations it needs with
 * the read tool rather than having every one rendered into context. This
 * is presentation for the web_read tool, so it lives with the extension
 * rather than in the public web library.
 */

import type { PageBundle } from "../../lib/web/reader.js";

/**
 * Render a page bundle as a pointer manifest. Lists only the
 * representations that exist and every screenshot tile path, and adds a
 * truncation note when the page overran the screenshot budget.
 */
export function formatManifest(bundle: PageBundle): string {
	const lines: string[] = [`# ${bundle.title}`, `Source: ${bundle.url}`, ""];
	if (bundle.excerpt) lines.push(bundle.excerpt, "");
	lines.push(
		"Captured this page as a bundle of representations. Open whichever " +
			"you need with the read tool:",
		"",
	);
	if (bundle.articlePath) {
		lines.push(`- article (markdown): ${bundle.articlePath}`);
	}
	if (bundle.innerTextPath) {
		lines.push(`- inner text: ${bundle.innerTextPath}`);
	}
	lines.push(`- DOM (HTML): ${bundle.domPath}`);
	if (bundle.screenshotPaths.length > 0) {
		lines.push(
			`- screenshot tiles (${bundle.screenshotPaths.length}, top to bottom):`,
		);
		for (const tilePath of bundle.screenshotPaths) {
			lines.push(`  - ${tilePath}`);
		}
	}
	if (bundle.truncated) {
		lines.push(
			"",
			"Note: the page was taller than the screenshot budget, so the " +
				"tiles were truncated. Read the inner text or DOM for the rest.",
		);
	}
	return lines.join("\n");
}
