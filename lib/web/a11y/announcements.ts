/**
 * What a screen reader would have said out loud.
 *
 * A sighted reviewer sees a banner appear. A screen reader user
 * hears something, or hears nothing at all, and nothing is the
 * bug worth catching. Live regions are the mechanism a page
 * uses to speak, so watching them answers "what did a screen
 * reader user hear when I pressed save".
 */

import type { Recorded } from "../telemetry/buffer.js";

/** Something the page announced through a live region. */
export interface Announcement {
	readonly politeness: "polite" | "assertive";
	readonly text: string;
	/** When it was announced, as epoch milliseconds. */
	readonly at: number;
}

/** Lay out what was announced, in the order it was said. */
export function renderAnnouncements(
	entries: readonly Recorded<Announcement>[],
	dropped = 0,
): string {
	if (entries.length === 0) return "Nothing was announced.";

	const lines = entries.map(
		({ item }) => `${item.politeness}: ${flatten(item.text)}`,
	);
	if (dropped > 0) {
		lines.push("", `${dropped} earlier announcements were dropped.`);
	}
	return lines.join("\n");
}

/** Put an announcement on one line, the way it is heard. */
function flatten(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The binding an injected observer reports through. */
export const ANNOUNCE_BINDING = "__piAnnounce";

/** The page-side array of regions the observer has nominated. */
export const CANDIDATE_REGISTRY = "__piLiveCandidates";

/**
 * A change the page made somewhere that might be announced.
 *
 * The observer decides nothing about whether this is a live
 * region. It reports where the change happened and lets the
 * browser rule on it.
 */
export interface AnnouncementCandidate {
	/** Identifies the document; a navigation starts a new one. */
	readonly epoch: string;
	/** Position in the page-side registry of nominated regions. */
	readonly index: number;
	readonly text: string;
	readonly at: number;
}

/**
 * Watch the page for anything that might be spoken.
 *
 * This is plain JavaScript source rather than a function, on
 * purpose. Anything injected into a page is serialized by
 * whatever compiled this module, and a compiler that rewrites
 * function bodies (esbuild's name helpers, a coverage
 * instrumenter) emits source referencing helpers the page has
 * never heard of, which throws before the observer registers.
 * Source text survives that untouched.
 *
 * It runs before the page's own scripts, so changes made during
 * load are caught too. It reports through a binding the session
 * installs; with no binding it does nothing rather than throwing
 * inside the page under inspection.
 *
 * It deliberately does not decide politeness. Chrome exposes no
 * way for page script to ask what the browser computed, and
 * reimplementing the rules here means missing whatever the
 * browser knows that this code does not: role=log is live,
 * aria-live=off is not, and the mapping changes as the ARIA
 * spec grows. So the observer nominates any region that could
 * plausibly carry live semantics and the browser rules on it.
 * Over-nominating costs one lookup; under-nominating loses an
 * announcement silently, which is the failure that matters.
 */
export const ANNOUNCEMENT_OBSERVER = `(() => {
  var BINDING = ${JSON.stringify(ANNOUNCE_BINDING)};
  var REGISTRY = ${JSON.stringify(CANDIDATE_REGISTRY)};
  var CANDIDATE_SELECTOR = "[aria-live], [role], output";
  var epoch = String(Date.now()) + "-" + String(Math.random()).slice(2, 8);

  globalThis[REGISTRY] = [];
  var indexByElement = new WeakMap();

  function indexOf(element) {
    var known = indexByElement.get(element);
    if (known !== undefined) return known;
    var index = globalThis[REGISTRY].length;
    globalThis[REGISTRY].push(element);
    indexByElement.set(element, index);
    return index;
  }

  function nominate(index, text) {
    var sink = globalThis[BINDING];
    if (sink) {
      sink({ epoch: epoch, index: index, text: text, at: Date.now() });
    }
  }

  function watch() {
    var observer = new MutationObserver(function (records) {
      var seen = {};
      for (var i = 0; i < records.length; i++) {
        var node = records[i].target;
        var element = node.nodeType === 1 ? node : node.parentElement;
        if (!element) continue;
        var region = element.closest(CANDIDATE_SELECTOR);
        if (!region) continue;
        var text = (region.textContent || "").trim();
        if (!text) continue;
        var index = indexOf(region);
        // One edit can raise several records against the same
        // region; a listener hears it once.
        var key = String(index) + "\\u0000" + text;
        if (seen[key]) continue;
        seen[key] = true;
        nominate(index, text);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  if (document.body) watch();
  else document.addEventListener("DOMContentLoaded", watch);
})();`;
