/**
 * The live wires a session collaborator drives the browser
 * through.
 *
 * Handed over as accessors rather than as captured references,
 * because crash recovery replaces the session's page and its
 * protocol channel wholesale. A collaborator holding the
 * originals would keep driving a tab that is never going to
 * answer, which is exactly the hang recovery exists to end.
 */

import type { BrowserContext, CDPSession, Page } from "puppeteer-core";

/** What a collaborator may reach of the session's machinery. */
export interface SessionWires {
	/** The current tab. */
	readonly page: () => Page;
	/** The current protocol channel. */
	readonly cdp: () => CDPSession;
	/** The browser context the session owns. */
	readonly context: () => BrowserContext;
	/** Wait out any crash recovery before touching the tab. */
	readonly ready: () => Promise<void>;
}
