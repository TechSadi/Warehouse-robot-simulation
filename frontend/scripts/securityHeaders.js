/**
 * The frontend's own security headers, generated at build time.
 *
 * The API sends a strict CSP and serves no HTML, so the policy that
 * actually governs the dashboard - the one that would stop an injected
 * script from loading a payload or beaconing data out - did not exist. The
 * limitation notes recorded that as "adding one is a hosting-configuration
 * change outside this codebase", which was true of the *header* and not of
 * the *policy*: the policy depends on where this build talks to, and that
 * is known here and nowhere else.
 *
 * So it is generated from `VITE_API_URL` and emitted three ways, because
 * the deployment targets disagree about how to be configured:
 *
 *   `<meta http-equiv>` in index.html - works on any static host with no
 *       configuration at all, including Vercel. This is the one that makes
 *       the policy real by default rather than by remembering to wire
 *       something up.
 *   `dist/_headers`   - Netlify (and Cloudflare Pages) read this.
 *   `dist/vercel.json` - Vercel reads this when the build output directory
 *       is the project root of the deployment.
 *
 * The meta tag cannot carry `frame-ancestors`, `report-uri` or `sandbox` -
 * those are header-only by specification - which is exactly why the header
 * files are emitted alongside it rather than instead of it. Clickjacking
 * protection therefore comes from `X-Frame-Options` in the header files,
 * plus `frame-ancestors` where a real header is available.
 */

/**
 * Where the browser is allowed to talk to.
 *
 * In a same-origin deployment (or local dev behind Vite's proxy) that is
 * just `'self'`. When the API is a separate service - this project's
 * documented target, Vercel plus Render - its origin has to be listed, and
 * its websocket origin with it, or the live view simply never connects.
 */
function connectSources(apiUrl) {
  const sources = ["'self'"];
  if (!apiUrl) return sources;

  try {
    const url = new URL(apiUrl);
    sources.push(url.origin);
    // Socket.IO upgrades to a websocket against the same host.
    sources.push(`${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`);
  } catch {
    // A malformed VITE_API_URL is a deployment mistake, not a reason to
    // emit a broken policy. Falling back to 'self' produces a build whose
    // API calls visibly fail, which is a far better outcome than one whose
    // CSP silently allows everything.
    console.warn(`[headers] VITE_API_URL is not a valid URL: ${apiUrl}`);
  }
  return sources;
}

/**
 * @param {{apiUrl?: string, dev?: boolean}} options
 * @returns {string} the Content-Security-Policy value
 */
export function buildCsp({ apiUrl = '', dev = false } = {}) {
  const directives = {
    "default-src": ["'self'"],
    // No `'unsafe-eval'`: nothing in this app evaluates strings as code,
    // and leaving it out is what makes a whole class of injection
    // unexploitable rather than merely difficult.
    "script-src": ["'self'"],
    // `'unsafe-inline'` for styles only, and reluctantly: Vite injects the
    // stylesheet inline in development, and recharts sets inline styles on
    // the elements it renders. Style injection is a defacement and a
    // data-exfiltration hazard rather than code execution, so this is a
    // materially smaller concession than the script equivalent - which is
    // not made.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", 'data:', 'blob:'],
    "font-src": ["'self'", 'data:'],
    "connect-src": connectSources(apiUrl),
    // The app has no frames, no plugins, and never posts a form anywhere.
    // Saying so costs nothing and removes the options an attacker would
    // otherwise have.
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "upgrade-insecure-requests": [],
  };

  if (dev) {
    // Vite's dev server needs eval for HMR and talks to itself over a
    // websocket. Never emitted into a production build.
    directives['script-src'].push("'unsafe-eval'");
    directives['connect-src'].push('ws:', 'wss:');
    delete directives['upgrade-insecure-requests'];
  }

  return Object.entries(directives)
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

/**
 * The rest of the header set, none of which the API's Helmet configuration
 * can supply because the API does not serve this HTML.
 */
export function securityHeaders({ apiUrl = '' } = {}) {
  return {
    'Content-Security-Policy': buildCsp({ apiUrl }),
    // Belt to frame-ancestors' braces, for anything that predates CSP 2.
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // Send the origin cross-site and the full path same-site: enough for
    // analytics and debugging, not enough to leak a path to a third party.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // This app asks for none of these. Denying them means an injected
    // script cannot ask on its behalf either.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    // Two years, subdomains included. Only meaningful over HTTPS, which
    // every documented deployment target is.
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  };
}

/** Netlify / Cloudflare Pages `_headers` format. */
export function toNetlifyHeaders(headers) {
  const lines = ['/*'];
  for (const [name, value] of Object.entries(headers)) lines.push(`  ${name}: ${value}`);
  return `${lines.join('\n')}\n`;
}

/** Vercel `vercel.json` format. */
export function toVercelConfig(headers) {
  return `${JSON.stringify(
    {
      headers: [
        {
          source: '/(.*)',
          headers: Object.entries(headers).map(([key, value]) => ({ key, value })),
        },
      ],
    },
    null,
    2
  )}\n`;
}

/**
 * A Vite plugin that writes the header files into the build output and
 * injects the meta-tag CSP into `index.html`.
 *
 * Build-time rather than a checked-in static file, because the policy is
 * not static: `connect-src` has to name whichever API origin this
 * particular build was pointed at, and a hand-maintained file would be one
 * deployment away from a policy that blocks the app's own API.
 */
/** @returns {import('vite').Plugin} */
export function securityHeadersPlugin() {
  let apiUrl = '';
  let isBuild = false;

  return {
    name: 'security-headers',
    configResolved(config) {
      isBuild = config.command === 'build';
      apiUrl = config.env?.VITE_API_URL || process.env.VITE_API_URL || '';
    },
    transformIndexHtml(html) {
      const csp = buildCsp({ apiUrl, dev: !isBuild });
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
            injectTo: /** @type {const} */ ('head-prepend'),
          },
        ],
      };
    },
    generateBundle() {
      if (!isBuild) return;
      const headers = securityHeaders({ apiUrl });
      this.emitFile({ type: 'asset', fileName: '_headers', source: toNetlifyHeaders(headers) });
      this.emitFile({ type: 'asset', fileName: 'vercel.json', source: toVercelConfig(headers) });
    },
  };
}
