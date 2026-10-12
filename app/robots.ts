import type { MetadataRoute } from "next";

// Atlas is private for now (the access gate in proxy.ts), so search engines are asked to
// stay out entirely; next.config.ts also sends X-Robots-Tag: noindex on every response, for
// the crawlers that ignore robots.txt or find a shared link. No sitemap is advertised.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
