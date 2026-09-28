/**
 * Human-readable names for robots and orders in log lines and live
 * notifications.
 *
 * Those messages used to print raw MongoDB ids ("Order 6aba4c36...
 * delivered by robot 6aba4c2d..."), which mean nothing to someone watching
 * the dashboard: the fleet roster names robots ("Robot 3") and the orders
 * panel identifies orders by their route ("(22,4) → (15,0)"). These
 * helpers produce the same names, and fall back to a short id when the
 * richer detail is not available - a label is cosmetic and must never be
 * the reason a message is not written.
 */

/** Last six characters of an id - enough to tell entries apart. */
function shortId(id) {
  const s = String(id ?? '');
  return s.length > 6 ? s.slice(-6) : s;
}

function formatPoint(point) {
  return `(${point.x},${point.y})`;
}

/** "Robot 3", or "robot #d9b77c" if the name is not known. */
function robotLabel(name, id) {
  return name ? String(name) : `robot #${shortId(id)}`;
}

/** "order (22,4) → (15,0)", or "order #d9b798" without its locations. */
function orderLabel(order, id) {
  if (order?.pickupLocation && order?.deliveryLocation) {
    return `order ${formatPoint(order.pickupLocation)} → ${formatPoint(order.deliveryLocation)}`;
  }
  return `order #${shortId(id ?? order?._id)}`;
}

/** Capitalises the first letter, for a label that starts a sentence. */
function sentenceCase(label) {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

module.exports = { shortId, robotLabel, orderLabel, sentenceCase };
