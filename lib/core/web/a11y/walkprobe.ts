/**
 * The page-side half of the keyboard walk.
 *
 * These are page source, in .page.js files beside this module,
 * because they declare helpers of their own, and the bundler renames every named inner binding
 * through a wrapper the page has never heard of. A function
 * handed over as a value would throw before it registered
 * anything, silently.
 */

/**
 * What counts as a modal, from the page's own point of view.
 *
 * A dialog that contains focus is doing its job, and a keyboard
 * checker that cannot tell that from a dead end reports the
 * reference implementation of the pattern as the defect it
 * exists to find.
 */
const MODAL_SELECTOR =
	'dialog[open], [role="dialog"][aria-modal="true"], ' +
	'[role="alertdialog"][aria-modal="true"]';

import { pageCall, pageScript } from "../page-script.ts";
import { DEEP_DOM } from "../snapshot/deep.ts";
import { PRESENTED } from "../snapshot/presented.ts";

/**
 * What to call a focus stop, shared by both halves of the walk.
 *
 * A form control carries none of its name on itself: the name sits
 * in a label pointing at it, a label wrapping it, or an element
 * named through aria-labelledby. Reading attributes alone made
 * every field in a form report as a bare INPUT, which is precisely
 * the listing a reviewer uses to check that tab order follows the
 * page. The browser already implements the label algorithm, so
 * `el.labels` is asked rather than the association being worked out
 * here.
 *
 * Handed to both probes rather than written twice. It was
 * written twice, the two copies drifted, and fixing the one that
 * collects candidates left the one that records stops still
 * answering the old way.
 */
const NAMING = pageScript(new URL("./naming.page.js", import.meta.url));

/**
 * Collect everything the browser will let focus land on, and
 * remember what each looks like at rest.
 *
 * The list is deliberately built from the browser's own view: an
 * element that is display:none or disabled is not focusable no
 * matter what its markup says, and asking the computed style is
 * the only way to know.
 */
export const WALK_COLLECT = pageCall(
	new URL("./walk-collect.page.js", import.meta.url),
	{
		helpers: [DEEP_DOM, NAMING, PRESENTED],
		values: { modalSelector: MODAL_SELECTOR },
	},
);

/**
 * Read where focus is now.
 *
 * The index is looked up against the same array the collection
 * pass stored, so identity is the element itself rather than a
 * selector that might match twice.
 */
export const WALK_READ = pageCall(
	new URL("./walk-read.page.js", import.meta.url),
	{ helpers: [NAMING], values: { modalSelector: MODAL_SELECTOR } },
);

/**
 * Remember where focus and the viewport were before the walk.
 *
 * The walk is one of the two reads that deliberately change the
 * page, so it owes the caller the page it was handed back. Tab
 * scrolls each stop into view, and the health digest runs the
 * keyboard check before the visual and design ones, so a walk
 * that leaves the page scrolled moves the ground under every
 * measurement that follows it in the same run. Performance now
 * runs ahead of the walk rather than behind it, for a related
 * reason: the walk's own work was being measured as the page's.
 *
 * Paired with WALK_RESTORE below, which puts both back.
 */
export const WALK_REMEMBER = pageScript(
	new URL("./walk-remember.page.js", import.meta.url),
);

/** Put focus and the scroll position back where the walk found them. */
export const WALK_RESTORE = pageScript(
	new URL("./walk-restore.page.js", import.meta.url),
);
