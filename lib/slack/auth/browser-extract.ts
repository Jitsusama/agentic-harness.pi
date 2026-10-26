/**
 * Automatic Slack credential extraction via browser.
 *
 * Launches Chrome (non-headless, using the user's existing
 * install), navigates to Slack, and polls localStorage and
 * cookies for the xoxc- token and xoxd- cookie. Works with
 * any Slack workspace; the user just needs to be logged in
 * (or log in when the browser opens).
 *
 * Uses puppeteer-core (no bundled browser) for consistency
 * with web-search-integration.
 */

import type { Browser } from "puppeteer-core";
import { resolveChromePath } from "../../core/web/chrome.ts";

/**
 * Default Slack URL to navigate to: the dedicated sign-in entry
 * point, not the marketing homepage. app.slack.com used to be here
 * instead, and it lands on a cookie-consent marketing page with no
 * sign-in link visible without scrolling - a real run needed a
 * person to find and click their own way to sign-in from there,
 * which is what this URL skips.
 */
const DEFAULT_SLACK_URL = "https://slack.com/signin";

/** Guidance printed once the browser opens, before the wait begins. */
const SIGN_IN_GUIDANCE = [
	"Opening Slack sign-in. To finish:",
	"  1. Sign in with your email (or SSO) as usual.",
	"  2. If asked to pick a workspace, click into the one you want.",
	'  3. If a screen offers "Open Slack" (desktop app) vs "use Slack',
	'     in your browser", click "use Slack in your browser" - this',
	"     tries that automatically, but don't wait on it if it's slow.",
	"This can take a few minutes depending on your organization's sign-in flow.",
].join("\n");

/** How often to poll for credentials (milliseconds). */
const POLL_INTERVAL_MS = 1000;

/** Default timeout: 5 minutes to allow for SSO, 2FA, workspace selection. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Extracted browser sign-in credentials. */
export interface BrowserCredentials {
	token: string;
	cookie: string;
}

/** How an extraction may be stopped, and whether its window shows. */
export interface ExtractOptions {
	/** Stops the extraction, closing its window, when it fires. */
	signal?: AbortSignal;
	/**
	 * Hides the window. Only useful where nobody signs in by hand, a test
	 * among them; a person needs to see it.
	 */
	headless?: boolean;
}

/**
 * Launch Chrome, navigate to Slack, and extract credentials.
 *
 * Opens a visible browser window so the user can log in if
 * needed. Polls localStorage for the xoxc- token and the
 * browser's cookie jar for the xoxd- session cookie.
 *
 * @param slackUrl - Slack URL to navigate to (default: the sign-in
 *   entry point, not a workspace or the marketing homepage)
 * @param timeoutMs - How long to wait before giving up
 * @param onStep - Called once, right after the browser opens, with
 *   the guidance a person watching needs to actually finish sign-in.
 *   Adapter-supplied rather than written straight to stderr here, so
 *   a host that isn't a bare terminal can surface it its own way.
 */
export async function extractFromBrowser(
	slackUrl = DEFAULT_SLACK_URL,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	onStep?: (message: string) => void,
	options: ExtractOptions = {},
): Promise<BrowserCredentials> {
	const { signal } = options;
	if (signal?.aborted) throw stopped(signal);
	const chromePath = resolveChromePath(process.env.CHROME_PATH);
	// Loaded here rather than at import, since this runs once per
	// Slack setup and the module is imported on every start.
	const { default: puppeteer } = await import("puppeteer-core");
	const browser = await puppeteer.launch({
		executablePath: chromePath,
		headless: options.headless ?? false,
		args: ["--no-sandbox", "--disable-setuid-sandbox"],
		// Puppeteer's handlers answer SIGINT with process.exit, taking the
		// exit from the host; the ones installed below kill Chrome without.
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false,
	});
	const unhook = killOnSignal(browser);

	let onAbort = (): void => {};
	const abandoned = new Promise<never>((_, reject) => {
		onAbort = () => reject(stopped(signal));
	});
	signal?.addEventListener("abort", onAbort, { once: true });
	// Given up on while Chrome was starting, which no listener heard.
	if (signal?.aborted) onAbort();

	try {
		const polling = pollForCredentials(
			browser,
			slackUrl,
			timeoutMs,
			onStep,
			signal,
		);
		if (signal === undefined) return await polling;
		// Closing the window below ends the poll with an error of its own,
		// which nobody is waiting for once the extraction was abandoned.
		polling.catch(() => undefined);
		return await Promise.race([polling, abandoned]);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		unhook();
		await closeWithin(browser, CLOSE_GRACE_MS);
	}
}

/** Watches Chrome until it holds both credentials or the clock runs out. */
async function pollForCredentials(
	browser: Browser,
	slackUrl: string,
	timeoutMs: number,
	onStep: ((message: string) => void) | undefined,
	signal: AbortSignal | undefined,
): Promise<BrowserCredentials> {
	const context = browser.defaultBrowserContext();
	const page = (await browser.pages())[0] ?? (await browser.newPage());
	await page.goto(slackUrl, { waitUntil: "domcontentloaded" });
	onStep?.(SIGN_IN_GUIDANCE);

	const startTime = Date.now();

	while (Date.now() - startTime < timeoutMs) {
		// Grab the most recent page, since Slack and SSO flows may open
		// new tabs or navigate, destroying the original context.
		const pages = await browser.pages();
		const activePage = pages[pages.length - 1] ?? page;

		// A workspace's own SSB redirect page (cloud-native.slack.com/
		// ssb/redirect, and its equivalents) defaults to prompting for
		// the desktop app, with a "use Slack in your browser" link as
		// the only way to reach the web client instead. Nothing here
		// wants the desktop app, and nothing clicks that link on its
		// own, so a real run sat on that splash page for the whole
		// five-minute budget until this was added.
		await clickUseInBrowser(activePage);

		// The cookie lives in the browser context, not the page,
		// so it survives navigations. Check it first.
		const cookies = await context.cookies();
		const dCookie = cookies.find(
			(c) => c.name === "d" && c.domain.includes("slack.com"),
		);
		const cookie = dCookie?.value;

		// Try to read the token from localStorage. This fails during
		// navigations (context destroyed) and on non-Slack pages
		// (SSO provider). Both are expected, so we just retry.
		const token = await extractTokenFromPage(activePage);

		if (token?.startsWith("xoxc-") && cookie?.startsWith("xoxd-")) {
			return { token, cookie };
		}

		await sleep(POLL_INTERVAL_MS);
		if (signal?.aborted) throw stopped(signal);
	}

	throw new Error(
		"Timed out waiting for Slack credentials. " +
			"Make sure you are logged into Slack in the browser window, " +
			"and that you have clicked into a specific workspace: a fresh " +
			"browser profile has not signed in yet, so app.slack.com shows a " +
			"workspace picker after sign-in rather than opening one directly, " +
			"and nothing here is extractable until a workspace is open.",
	);
}

/**
 * Click a "use Slack in your browser" link if the active page is
 * showing one, so the desktop-app splash page a workspace redirect
 * lands on doesn't sit there indefinitely. A no-op, never throwing,
 * on any page that isn't showing one (mid-navigation, cross-origin,
 * or just a different page entirely).
 *
 * Dispatches a real mouse click at the link's on-screen position
 * rather than calling the DOM `.click()` method in-page: the latter
 * produces a synthetic event (`isTrusted: false`), which this splash
 * page's own handler silently ignores, exactly the "nothing changes"
 * a real run showed before this was found. A CDP-level mouse click
 * is indistinguishable from one a person made.
 */
async function clickUseInBrowser(
	page: import("puppeteer-core").Page,
): Promise<void> {
	try {
		const center = await page.evaluate(() => {
			const links = Array.from(document.querySelectorAll("a"));
			const match = links.find((a) =>
				/use slack in (your|the) browser/i.test(a.textContent ?? ""),
			);
			if (!match) return null;
			const rect = match.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return null;
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		});
		if (center) await page.mouse.click(center.x, center.y);
	} catch {
		// Execution context destroyed, page closed, or cross-origin
		// frame. Same as extractTokenFromPage: all expected, so the
		// next poll just tries again.
	}
}

/**
 * Try to extract the xoxc- token from a page's localStorage.
 *
 * Returns null if the page isn't on Slack yet, is mid-navigation,
 * or the execution context was destroyed. All expected during
 * SSO flows.
 */
async function extractTokenFromPage(
	page: import("puppeteer-core").Page,
): Promise<string | null> {
	try {
		return await page.evaluate(() => {
			try {
				const raw = localStorage.getItem("localConfig_v2");
				if (!raw) return null;
				const config = JSON.parse(raw);
				const teams = config?.teams;
				if (!teams) return null;
				for (const t of Object.values(teams) as Array<
					Record<string, unknown>
				>) {
					const tok = t?.token as string | undefined;
					if (tok?.startsWith("xoxc-")) return tok;
				}
				return null;
			} catch {
				return null;
			}
		});
	} catch {
		// Execution context destroyed (navigation), page closed, or
		// cross-origin frame (SSO provider). All expected, so retry.
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long a window has to close before its Chrome is killed outright. */
const CLOSE_GRACE_MS = 5000;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Kills this Chrome, and the helpers it started, on a signal that would
 * otherwise orphan it. The exit belongs to the host: with anybody else
 * listening this only kills Chrome, and alone it raises the signal again
 * so the default, being killed by it, still happens. Returns the unhook.
 */
function killOnSignal(browser: Browser): () => void {
	const hooks = SIGNALS.map((signal) => {
		const hook = (): void => {
			killGroup(browser);
			if (process.listenerCount(signal) === 0)
				process.kill(process.pid, signal);
		};
		process.once(signal, hook);
		return { signal, hook };
	});
	return () => {
		for (const { signal, hook } of hooks) process.off(signal, hook);
	};
}

/** Closes Chrome politely, and kills it when that does not happen in time. */
async function closeWithin(browser: Browser, graceMs: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			browser.close(),
			new Promise((resolve) => {
				timer = setTimeout(resolve, graceMs);
			}),
		]);
	} catch {
		// Already gone, killed by a signal or crashed; the kill below makes
		// sure of it either way.
	} finally {
		clearTimeout(timer);
	}
	killGroup(browser);
}

/** Kills Chrome's whole process group, which may already have exited. */
function killGroup(browser: Browser): void {
	const pid = browser.process()?.pid;
	if (pid === undefined) return;
	try {
		// Puppeteer starts Chrome as a group leader, so the helpers go too.
		process.kill(-pid, "SIGKILL");
	} catch {
		// ESRCH: the group has already exited, which is what was wanted.
	}
}

/** The error an abandoned extraction rejects with. */
function stopped(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason;
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	return new DOMException(
		"Slack credential extraction was stopped.",
		"AbortError",
	);
}
