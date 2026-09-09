const env = require('../config/env');

/**
 * Outbound email, behind a transport seam.
 *
 * "There is no email infrastructure in this project" was the reason
 * password reset and email verification were out of scope. That reason
 * only ever justified deferring the *delivery* - and delivery is the one
 * part of those flows that is genuinely somebody else's software. So the
 * flows are implemented properly and the transport is a choice:
 *
 *   console  - writes the message, link and all, to the server log. The
 *              default outside production, and what makes the flows usable
 *              on a laptop with no mail account and testable end to end.
 *   webhook  - POSTs the message to MAIL_WEBHOOK_URL. Enough to wire this
 *              to a real provider (or a queue, or a Zapier hook) without
 *              taking on an SMTP dependency this project has no other use
 *              for.
 *   none     - drops it. For a deployment that deliberately does not want
 *              these flows reachable at all.
 *
 * Production refuses to fall back to `console`: a reset link printed to a
 * log nobody reads is not a delivered email, and pretending otherwise
 * would mean shipping a password reset that silently does not work. Set
 * MAIL_TRANSPORT explicitly there.
 *
 * Nothing here throws into the request path. A caller must not be able to
 * tell a delivered message from an undelivered one - if it could, the
 * "forgot password" endpoint would become the account-existence oracle
 * that its uniform response is specifically designed not to be.
 */

async function sendViaWebhook(message) {
  const url = env.mail.webhookUrl;
  if (!url) {
    console.error('[mail] MAIL_TRANSPORT=webhook but MAIL_WEBHOOK_URL is not set; message dropped');
    return { delivered: false, reason: 'no-webhook-url' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.mail.webhookTimeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.mail.webhookToken ? { authorization: `Bearer ${env.mail.webhookToken}` } : {}),
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[mail] webhook responded ${response.status}`);
      return { delivered: false, reason: `http-${response.status}` };
    }
    return { delivered: true };
  } catch (err) {
    console.error('[mail] webhook delivery failed:', err.message);
    return { delivered: false, reason: 'transport-error' };
  } finally {
    clearTimeout(timeout);
  }
}

function sendViaConsole(message) {
  // One block, clearly delimited, because in development this *is* the
  // inbox and it has to be findable in a busy log.
  console.log(
    [
      '',
      '──────────── outbound mail (console transport) ────────────',
      `to:      ${message.to}`,
      `subject: ${message.subject}`,
      '',
      message.text,
      '───────────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );
  return { delivered: true };
}

/**
 * @param {{to: string, subject: string, text: string, kind?: string}} message
 * @returns {Promise<{delivered: boolean, reason?: string}>}
 */
async function send(message) {
  switch (env.mail.transport) {
    case 'webhook':
      return sendViaWebhook(message);
    case 'none':
      return { delivered: false, reason: 'transport-disabled' };
    case 'console':
    default:
      if (env.isTest) return { delivered: true }; // no noise in the suite
      return sendViaConsole(message);
  }
}

/** Where the user is sent to finish a flow. The frontend owns these
 * routes; the API only needs to know its own client's base URL. */
function link(path, token) {
  const base = env.mail.appBaseUrl.replace(/\/+$/, '');
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

async function sendPasswordReset({ to, token }) {
  return send({
    kind: 'password_reset',
    to,
    subject: 'Reset your warehouse simulation password',
    text: [
      'Someone asked to reset the password for this account.',
      '',
      link('/reset-password', token),
      '',
      `This link expires in ${Math.round(env.auth.passwordResetTtlSeconds / 60)} minutes and can be used once.`,
      'If it was not you, no action is needed - the link above is the only',
      'thing that can change the password, and nothing has changed yet.',
    ].join('\n'),
  });
}

async function sendEmailVerification({ to, token }) {
  return send({
    kind: 'email_verification',
    to,
    subject: 'Confirm your warehouse simulation email address',
    text: [
      'Confirm this address to finish setting up your account.',
      '',
      link('/verify-email', token),
      '',
      `This link expires in ${Math.round(env.auth.emailVerificationTtlSeconds / 3600)} hours.`,
    ].join('\n'),
  });
}

module.exports = { send, link, sendPasswordReset, sendEmailVerification };
