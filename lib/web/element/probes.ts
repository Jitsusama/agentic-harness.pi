/**
 * Asking the browser about one element.
 *
 * Page sources rather than functions, for the same reason the
 * accessibility observer is: the compiler wraps named inner
 * bindings in a __name helper the page has never heard of, so
 * a serialized function that declares helpers of its own
 * throws on arrival.
 */

/**
 * Who receives a click at a point, when it is not the element
 * being asked about.
 *
 * Runs with the element as its receiver and the hit node as its
 * only argument. Anything the element contains counts as
 * itself, since a click there still reaches it. Returns a short
 * description of the obstruction, or null when there is none.
 */
/**
 * Stop an element's own text from painting, and put it back.
 *
 * Runs with the element as its receiver. Only colour and shadow are
 * touched, because neither affects layout: the glyphs still occupy
 * the same pixels and simply leave no mark, which is what lets two
 * shots of the same region be subtracted from one another.
 *
 * The element's own inline values are remembered on the node itself
 * rather than in the caller, so a restore still works if the caller
 * lost track of what it changed. An element with no inline colour of
 * its own is restored by removing the property, not by writing an
 * empty string over it, since those differ once a stylesheet has an
 * opinion.
 */
export const HIDE_TEXT = `function (hidden) {
  var KEY = "__piHiddenText";
  if (hidden) {
    if (!this[KEY]) {
      this[KEY] = {
        color: this.style.getPropertyValue("color"),
        colorPriority: this.style.getPropertyPriority("color"),
        shadow: this.style.getPropertyValue("text-shadow"),
        shadowPriority: this.style.getPropertyPriority("text-shadow")
      };
    }
    this.style.setProperty("color", "transparent", "important");
    this.style.setProperty("text-shadow", "none", "important");
    return true;
  }
  var had = this[KEY];
  if (!had) return false;
  this.style.removeProperty("color");
  this.style.removeProperty("text-shadow");
  if (had.color) {
    this.style.setProperty("color", had.color, had.colorPriority);
  }
  if (had.shadow) {
    this.style.setProperty("text-shadow", had.shadow, had.shadowPriority);
  }
  delete this[KEY];
  return true;
}`;

/**
 * Select everything in a text field, the way the field itself
 * offers to.
 *
 * Runs with the element as its receiver. Used instead of a
 * triple click so that clearing a field does not need an
 * unobstructed centre, and instead of a select-all shortcut so
 * there is no platform to guess at.
 */
export const SELECT_TEXT_PROBE = `function () {
  if (typeof this.select === "function") {
    this.select();
    return true;
  }
  return false;
}`;

/**
 * What an element says, holds, and is tagged with.
 *
 * Runs with the element as its receiver. Text is trimmed and
 * capped, because a container's textContent can be the whole
 * page and the question being asked is almost always about a
 * short piece of it. Only data attributes and a handful of
 * state attributes are returned: the rest are either already in
 * the accessibility tree or noise.
 */
export const CONTENT_PROBE = `function () {
  var text = (this.textContent || "").replace(/\\s+/g, " ").trim();
  if (text.length > 400) text = text.slice(0, 400) + "...";
  var attributes = [];
  var names = this.getAttributeNames ? this.getAttributeNames() : [];
  for (var at = 0; at < names.length; at++) {
    var name = names[at];
    if (name.indexOf("data-") === 0 || name === "disabled" ||
        name === "readonly" || name === "open" || name === "hidden" ||
        name === "contenteditable" || name === "autocomplete" ||
        name === "inputmode" || name === "type" || name === "name") {
      attributes.push([name, this.getAttribute(name)]);
    }
  }
  var held;
  if (typeof this.value === "string") held = this.value;
  return { text: text, value: held, attributes: attributes };
}`;

export const OCCLUDER_PROBE = `function (hit) {
  if (!hit || hit === this || this.contains(hit)) return null;
  var described = hit.nodeName.toLowerCase();
  if (hit.id) described += " id=" + hit.id;
  else if (hit.classList && hit.classList.length) {
    described += " class=" + hit.classList[0];
  }
  return described;
}`;
