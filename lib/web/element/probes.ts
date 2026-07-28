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
