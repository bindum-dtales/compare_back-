// Canonical company domain: the bare, lower-case hostname.
//
//   "https://www.DTales.tech/about?x=1"  →  "dtales.tech"
//   "http://dtales.tech:8080/"           →  "dtales.tech"
//   "dtales.tech"                        →  "dtales.tech"   (scheme optional, https assumed)
//
// Rules: http/https only; scheme, port, path, query, fragment and credentials dropped;
// a single leading "www." stripped (www.x.com and x.com are the same site in practice);
// trailing dot removed. Other subdomains are kept (blog.x.com ≠ x.com).
// Rejected: anything URL() can't parse, non-http(s) schemes, IP addresses, localhost and
// single-label hosts — the research engine will fetch this host, so no internal targets.

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function normalizeDomain(input: string): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  // "mailto:x@y.com", "javascript:…": a scheme without "//" — not a bare host (a bare host's ":" is a port).
  if (!hasScheme && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw)) return null;
  const withScheme = hasScheme ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // URL() already lower-cases and punycodes the hostname.
  const host = url.hostname.replace(/\.$/, "").replace(/^www\./, "");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TLD.test(labels.at(-1)!)) return null;
  return host;
}
