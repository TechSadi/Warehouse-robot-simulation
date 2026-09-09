const Log = require('../models/Log');
const asyncHandler = require('../utils/asyncHandler');
const { findAccessibleWarehouse, ACCESS } = require('../middleware/authorize');

/**
 * Where the dashboard reports its own render failures.
 *
 * The frontend's `ErrorBoundary` logged to the console and stopped there,
 * which meant a render error in a deployed build was invisible unless a
 * user thought to mention it - the documented "no telemetry" gap. This is
 * the smallest thing that closes it honestly: the client posts what broke,
 * the server records it as a log entry the user can already read in the
 * Logs panel, and nobody has to run an observability stack for a portfolio
 * project.
 *
 * Everything a client sends is treated as hostile text, because it is:
 *
 *  - **Authenticated.** An open error-reporting endpoint is an open
 *    write-anything-to-the-database endpoint.
 *  - **Server-assigned `source` and `level`.** A client cannot forge a log
 *    line that looks like it came from the simulation engine - the same
 *    rule the logs API already enforces (Log.source is server-assigned).
 *  - **Warehouse ownership checked.** A report may name a warehouse so the
 *    entry lands in the right Logs panel; naming someone else's is how a
 *    client would write into another user's log.
 *  - **Everything truncated.** A stack trace is unbounded input. The
 *    schema caps `message` at 500 characters; the stack is capped here and
 *    stored as metadata rather than being spliced into the message.
 */

/** Bounded, and only the top of a stack - the frames that name the failing
 * component are at the top, and the rest is React internals. */
function clip(value, max) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

const reportClientError = asyncHandler(async (req, res) => {
  const { message, name, componentStack, stack, url, boundary } = req.body;

  // A report may name a warehouse so it lands in that warehouse's log.
  // Unowned or unknown, and it is recorded without one rather than
  // rejected: losing the error is worse than losing its context.
  let warehouseId = null;
  if (req.body.warehouseId) {
    // VIEW is the right bar: a viewer watching a shared warehouse can
    // hit a render bug in it too, and their report belongs in that
    // warehouse's log rather than nowhere.
    const warehouse = await findAccessibleWarehouse(req.body.warehouseId, req.userId, ACCESS.VIEW);
    warehouseId = warehouse ? warehouse._id : null;
  }

  await Log.create({
    level: 'error',
    // Server-assigned, so a client cannot author a log line that appears
    // to have come from the engine or the order service.
    source: 'client',
    message: clip(`${boundary ? `[${boundary}] ` : ''}${name ? `${name}: ` : ''}${message}`, 500),
    meta: {
      componentStack: clip(componentStack, 2000),
      stack: clip(stack, 2000),
      url: clip(url, 300),
      userAgent: clip(req.get('user-agent'), 300),
      userId: String(req.userId),
    },
    warehouseId,
  });

  // 202, not 201: the client is telling us something, not creating a
  // resource it will refer to again. It should never block on this, and
  // must never retry it into a loop - see frontend/src/api/telemetry.js.
  res.status(202).json({ success: true, data: { recorded: true } });
});

module.exports = { reportClientError };
