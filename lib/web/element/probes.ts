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

export const OCCLUDER_PROBE = `function (hit) {
  if (!hit || hit === this || this.contains(hit)) return null;
  var described = hit.nodeName.toLowerCase();
  if (hit.id) described += " id=" + hit.id;
  else if (hit.classList && hit.classList.length) {
    described += " class=" + hit.classList[0];
  }
  return described;
}`;
