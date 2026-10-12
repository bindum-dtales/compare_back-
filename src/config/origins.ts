// FRONTEND_URL → the CORS allow-list. Only browsers that call the API cross-origin need an entry
// (the frontend in direct mode, i.e. NEXT_PUBLIC_API_BASE_URL). Through the Next /api proxy the
// browser is same-origin, so production can leave it unset.

export const DEV_FRONTEND_ORIGIN = "http://localhost:3000";

/**
 * Comma-separated origins, each normalized to scheme://host[:port] ("https://x.com/" → "https://x.com",
 * which is what browsers send in Origin). Unset or empty: the local dev frontend outside production,
 * no cross-origin browsers in production. Throws on wildcards, paths and non-http(s) values.
 */
export function parseCorsOrigins(value: string | undefined, nodeEnv: string): string[] {
  const entries = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return nodeEnv === "production" ? [] : [DEV_FRONTEND_ORIGIN];

  return [
    ...new Set(
      entries.map((entry) => {
        if (entry.includes("*")) throw new Error(`FRONTEND_URL must list exact origins; wildcards are not allowed ("${entry}").`);
        let url: URL;
        try {
          url = new URL(entry);
        } catch {
          throw new Error(`FRONTEND_URL entry "${entry}" is not a URL. Use e.g. https://score.example.com.`);
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`FRONTEND_URL entry "${entry}" must use http or https.`);
        if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
          throw new Error(`FRONTEND_URL entry "${entry}" must be an origin only (scheme, host and optional port), without a path.`);
        }
        return url.origin;
      }),
    ),
  ];
}
