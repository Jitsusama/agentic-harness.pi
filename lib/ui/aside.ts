/**
 * Something to say beside the conversation, without writing behind pi's
 * renderer.
 *
 * pi draws its screen by keeping a picture of every row and writing only
 * what changed. Anything written to the terminal directly, such as
 * `console.error`, lands wherever the cursor happens to be, usually the
 * editor, and leaves that picture wrong: rows pi thinks it drew are
 * gone or doubled, and they stay that way until something redraws them.
 * A session's housekeeping, which runs at every start and every reload,
 * did exactly that. So it says what it has to say through pi's own
 * notices while there is a screen, and to standard error only when there
 * is none, as in print mode, where nothing is drawn over.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** How much a line matters, in pi's notice levels. */
export type AsideLevel = "info" | "warning" | "error";

/** Says one line, or a few, beside the conversation. */
export type Aside = (text: string, level?: AsideLevel) => void;

/** The part of a context an aside needs. */
export type AsideContext = Pick<ExtensionContext, "hasUI" | "ui">;

/** An aside for this session, said through its screen when it has one. */
export function asideFor(ctx: AsideContext): Aside {
	return (text, level = "warning") => {
		if (!ctx.hasUI) {
			process.stderr.write(`${text}\n`);
			return;
		}
		try {
			ctx.ui.notify(text, level);
		} catch {
			// The session that started this has been replaced, by a reload
			// or a new session, and its screen went with it. Writing to the
			// terminal instead would break the screen that replaced it, and
			// the housekeeping that had this to say runs again there.
		}
	};
}
