import { describe, expect, it } from "vitest";
import { normalizeDomain } from "../src/utils/domain.js";

describe("normalizeDomain", () => {
  it.each([
    "https://dtales.tech",
    "https://dtales.tech/",
    "http://dtales.tech",
    "https://www.dtales.tech",
    "https://WWW.DTales.Tech/about?ref=x#top",
    "https://dtales.tech:8443/",
    "https://user:pass@dtales.tech",
    "dtales.tech",
    "www.dtales.tech/",
    "  https://dtales.tech.  ",
  ])("%s → dtales.tech", (input) => {
    expect(normalizeDomain(input)).toBe("dtales.tech");
  });

  it("keeps meaningful subdomains and multi-part TLDs", () => {
    expect(normalizeDomain("https://blog.dtales.tech")).toBe("blog.dtales.tech");
    expect(normalizeDomain("https://www.acme.co.uk/")).toBe("acme.co.uk");
    expect(normalizeDomain("https://münchen.de")).toBe("xn--mnchen-3ya.de");
  });

  it.each([
    "",
    "   ",
    "not-a-url",
    "https://",
    "ftp://dtales.tech",
    "javascript:alert(1)",
    "mailto:hi@dtales.tech",
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://[::1]/",
    "http://10.0.0.5",
    "https://dtales",
    "https://dtales.tech extra",
    "https://-bad-.com",
  ])("rejects %j", (input) => {
    expect(normalizeDomain(input)).toBeNull();
  });
});
