/**
 * One error type for everything that crosses the network boundary, and one
 * place that turns it into a sentence a person can act on.
 *
 * Before this, three different failure shapes reached the UI: an `Error`
 * carrying the server's message, a raw `TypeError: Failed to fetch` when
 * the network was down, and (over Socket.IO) a bare payload object. Panels
 * rendered whichever one they got verbatim, so "Failed to fetch" - which
 * tells a user nothing and suggests no next step - was a normal thing to
 * see. Normalising here means every surface can say something useful
 * without each one re-deriving what a 401 or a 429 means.
 */
export class ApiError extends Error {
  constructor(message, { status = 0, details = null, cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }

  /** No HTTP response at all - DNS, offline, CORS, server down. */
  get isNetworkError() {
    return this.status === 0;
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isForbidden() {
    return this.status === 403;
  }

  get isRateLimited() {
    return this.status === 429;
  }

  /** Whether trying the same thing again could plausibly succeed. A 400 is
   * the caller's fault and will fail identically forever; a 503 will not. */
  get isRetryable() {
    return this.isNetworkError || this.isRateLimited || this.status >= 500;
  }
}

/**
 * Status codes the server's own message does not explain well enough on
 * its own. Anything not listed here keeps the server's wording - it is
 * more specific than anything a generic table could say, and on the login
 * path it is deliberately vague for anti-enumeration reasons that a
 * client-side rewrite would undo.
 */
const STATUS_FALLBACK = {
  0: "Can't reach the server. Check your connection, then try again.",
  401: 'Your session has expired. Sign in again to continue.',
  403: "You don't have access to this warehouse.",
  404: 'That no longer exists. It may have been deleted from another session.',
  429: 'Too many requests in a row. Wait a moment, then try again.',
  500: 'The server hit an unexpected error. Try again in a moment.',
  502: 'The server is unreachable right now. Try again in a moment.',
  503: 'The server is temporarily unavailable. Try again in a moment.',
};

/**
 * A single human-readable sentence for any thrown value. Field-level
 * validation details are appended when the server sent them, because
 * "Validation failed" alone leaves a person guessing which field.
 */
export function describeError(error) {
  if (!error) return 'Something went wrong.';

  const status = typeof error.status === 'number' ? error.status : null;
  const serverMessage = typeof error.message === 'string' ? error.message.trim() : '';

  // Status 0 means no response ever arrived, so there is no server wording
  // to preserve - only the transport's own, which is accurate and useless
  // ("Failed to fetch", "NetworkError when attempting to fetch resource",
  // "Network request failed").
  const noResponse = !status;

  let message = serverMessage;
  if (!message || noResponse) {
    message = STATUS_FALLBACK[status ?? 0] || 'Something went wrong.';
  } else if (STATUS_FALLBACK[status] && /^request failed/i.test(message)) {
    // The client's own placeholder for a response with no error body. The
    // status is the only real information in it, so say what the status means.
    message = STATUS_FALLBACK[status];
  }

  const fields = formatValidationDetails(error.details);
  return fields ? `${message} (${fields})` : message;
}

/** express-validator sends `[{ field, message }]`; surface it rather than
 * dropping it, since it is the only part that says *which* input was wrong. */
function formatValidationDetails(details) {
  if (!Array.isArray(details) || details.length === 0) return null;
  return details
    .slice(0, 3)
    .map((d) => (d?.field ? `${d.field}: ${d.message}` : d?.message))
    .filter(Boolean)
    .join('; ');
}
