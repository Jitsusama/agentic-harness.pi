/**
 * Asking the browser for style facts.
 *
 * These are page sources rather than functions, for the same
 * reason the accessibility observer is: whatever compiles this
 * module may rewrite function bodies, and the page has never
 * heard of the helpers that rewriting introduces. Source text
 * survives compilation untouched.
 *
 * They exist so that nothing in this domain has to restate what
 * a browser already computes. CSS knowledge written down here
 * would drift from the engine it claims to describe.
 */

/**
 * Shorthands worth reading in place of the sides they cover.
 *
 * A computed-style enumeration yields longhands only, so a
 * capture has to ask for these by name. The browser serializes
 * them, which is why curation never composes one itself.
 */
export const SHORTHAND_PROPERTIES: readonly string[] = [
	"margin",
	"padding",
	"inset",
	"border-width",
	"border-style",
	"border-color",
];

/**
 * Read every computed property of an element, plus the
 * shorthands the enumeration leaves out.
 *
 * A function declaration, to be invoked with the element as its
 * receiver: Runtime.callFunctionOn with the element's objectId.
 */
export const COMPUTED_STYLE_PROBE = `function (shorthands) {
  var styles = getComputedStyle(this);
  var out = {};
  for (var i = 0; i < styles.length; i++) {
    var name = styles[i];
    out[name] = styles.getPropertyValue(name);
  }
  for (var j = 0; j < shorthands.length; j++) {
    out[shorthands[j]] = styles.getPropertyValue(shorthands[j]);
  }
  return out;
}`;

/**
 * Read what every property computes to when nobody has set it.
 *
 * An element with all:initial reports the engine's own initial
 * values, which is the honest answer to "was this touched".
 * The element has to be in the document to have a computed
 * style at all, so it is added and taken away again within the
 * one evaluation, before anything can paint. It is left empty
 * and otherwise unstyled: hiding it would report display none
 * as the initial display and suppress that property everywhere.
 *
 * A function expression, to be invoked through asCall.
 */
export const INITIALS_PROBE = `(function (shorthands) {
  var host = document.createElement("div");
  host.style.setProperty("all", "initial");
  document.documentElement.appendChild(host);
  var styles = getComputedStyle(host);
  var out = {};
  for (var i = 0; i < styles.length; i++) {
    var name = styles[i];
    out[name] = styles.getPropertyValue(name);
  }
  for (var j = 0; j < shorthands.length; j++) {
    out[shorthands[j]] = styles.getPropertyValue(shorthands[j]);
  }
  host.remove();
  return out;
})`;

/**
 * Turn a function-expression source into an expression that
 * calls it, for protocols that evaluate an expression rather
 * than invoke a function.
 */
export function asCall(source: string, ...args: readonly unknown[]): string {
	const call = args.map((arg) => JSON.stringify(arg)).join(", ");
	return `(${source})(${call})`;
}
