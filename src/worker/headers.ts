/** Security headers applied to every response (assets and API). */


/** Explicit wss: origins for CSP connect-src (Safari < 15.4), from the allowlist config only, never from Host (L4). */
export function wssOrigins(env: { ALLOWED_ORIGINS?: string }): string[] {
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((x) => x.trim())
    .filter((x) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(x)).map((x) => 'wss://' + x.slice(8));
}

export function insecureDev(env: { DEV_INSECURE?: string }, url: URL): boolean {
  return env.DEV_INSECURE === '1' && url.protocol === 'http:';
}



export function csp(_host: string, secure = true, wss: string[] = []): string {
  const parts = [
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com https://s.ytimg.com",
    "style-src 'self'",
    "img-src 'self' data: blob: https://i.ytimg.com",
    "font-src 'self'",
    // 'self' covers same-origin wss:; nothing is derived from the Host header (checklist 2).
    // Explicit wss: origins come from the ALLOWED_ORIGINS config (older Safari), never from the request.
    ["connect-src 'self'", ...wss].join(' '),
    "media-src 'self' blob:",
    'frame-src https://www.youtube-nocookie.com',
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  // Production is always https. Only the local LAN dev launcher (plain http) skips the upgrade.
  if (secure) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

export function withSecurityHeaders(res: Response, host: string, secure = true, wss: string[] = []): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set('Content-Security-Policy', csp(host, secure, wss));
  h.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (secure) h.set('Strict-Transport-Security', 'max-age=31536000');
  h.set('X-Frame-Options', 'DENY');
  return out;
}

export const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';
