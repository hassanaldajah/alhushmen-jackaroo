export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace;
  /** Secrets (wrangler secret put ...). Never logged, never written to files. */
  PASSPHRASE?: string;
  SESSION_SECRET?: string;
  YT_API_KEY?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Optional generic TURN: comma-separated turn:/turns: URLs plus static username/credential (secrets). */
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  /** Optional Turnix API token (turnix.io free plan); used server-side only. */
  TURNIX_API_TOKEN?: string;
  /** Comma-separated allowed origins, exact match only (production origin + dev origins in .dev.vars). */
  ALLOWED_ORIGINS?: string;
  /** "1" only in the local LAN dev launcher (--var): allows plain-http cookie + no HSTS/upgrade. Never set in production. */
  DEV_INSECURE?: string;
}
