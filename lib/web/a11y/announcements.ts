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

/**
 * Watch the page for anything a screen reader would speak.
 *
 * This is plain JavaScript source rather than a function, on
 * purpose. Anything injected into a page is serialized by
 * whatever compiled this module, and a compiler that rewrites
 * function bodies (esbuild's name helpers, a coverage
 * instrumenter) emits source referencing helpers the page has
 * never heard of, which throws before the observer registers.
 * Source text survives that untouched.
 *
 * It runs before the page's own scripts, so announcements made
 * during load are caught too. It reports through a binding the
 * session installs; with no binding it does nothing rather than
 * throwing inside the page under inspection.
 *
 * Politeness follows the mechanism that made the region live:
 * an explicit aria-live wins, then role alert or status, then
 * an output element.
 */
export const ANNOUNCEMENT_OBSERVER = `(() => {
  var BINDING = ${JSON.stringify(ANNOUNCE_BINDING)};

  function report(politeness, text) {
    var sink = globalThis[BINDING];
    if (sink) sink({ politeness: politeness, text: text, at: Date.now() });
  }

  function politenessOf(element) {
    var live = element.closest("[aria-live]");
    if (live) {
      var declared = live.getAttribute("aria-live");
      if (declared === "off") return null;
      return declared === "assertive" ? "assertive" : "polite";
    }
    var roled = element.closest("[role]");
    var role = roled ? roled.getAttribute("role") : null;
    if (role === "alert") return "assertive";
    if (role === "status") return "polite";
    if (element.closest("output")) return "polite";
    return null;
  }

  function watch() {
    var observer = new MutationObserver(function (records) {
      var said = {};
      for (var i = 0; i < records.length; i++) {
        var node = records[i].target;
        var element = node.nodeType === 1 ? node : node.parentElement;
        if (!element) continue;
        var politeness = politenessOf(element);
        if (!politeness) continue;
        var text = (element.textContent || "").trim();
        if (!text) continue;
        // One edit can raise several records against the same
        // region; a listener hears it once.
        var key = politeness + "\\u0000" + text;
        if (said[key]) continue;
        said[key] = true;
        report(politeness, text);
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
