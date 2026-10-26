/**
 * Cross-platform URL opener. Launches the system default browser.
 */

import { execFile } from "node:child_process";

/** Open a URL in the user's default browser. */
export function openInBrowser(url: string): void {
	const platform = process.platform;

	if (platform === "darwin") {
		execFile("open", [url], ignoreError);
	} else if (platform === "win32") {
		execFile("cmd", ["/c", "start", url], ignoreError);
	} else {
		execFile("xdg-open", [url], ignoreError);
	}
}

/**
 * Browser launch is best-effort. If it fails (e.g. headless
 * server, missing xdg-open), the user can still copy the URL
 * shown in the terminal.
 */
function ignoreError(_error: Error | null) {
	// Intentionally empty: URL is displayed as fallback.
}
