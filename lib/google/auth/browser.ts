/**
 * Cross-platform URL opener. Launches the system default browser.
 */

import { execFile } from "node:child_process";

/** Open a URL in the user's default browser. */
export function openInBrowser(url: string): void {
	const platform = process.platform;

	if (platform === "darwin") {
		execFile("open", [url], ignoreErrors);
	} else if (platform === "win32") {
		execFile("cmd", ["/c", "start", url], ignoreErrors);
	} else {
		// Linux and other Unix-like systems
		execFile("xdg-open", [url], ignoreErrors);
	}
}

/** Silently ignore errors: the URL is also displayed as a fallback. */
function ignoreErrors(error: Error | null) {
	// Browser launch is best-effort. If it fails (e.g. headless
	// server, missing xdg-open), the user can still copy the URL
	// shown in the terminal.
	if (error) {
		// Intentionally ignored: URL is displayed as fallback
	}
}
