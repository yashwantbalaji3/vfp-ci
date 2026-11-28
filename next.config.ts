import type { NextConfig } from "next";

/**
 * Content Security Policy (R1). The browser may load code, styles, images and data only
 * from this site itself. Two honest limits, both recorded in docs/11:
 *  - Inline scripts are allowed, because the framework streams page data in inline scripts
 *    and a per-request nonce cannot be combined with the prerendered page shells this app
 *    uses. Pages never insert raw HTML, so this is the smallest opening that works.
 *  - Nothing outside this site is allowed at all. When Map Discovery arrives (docs/20), its
 *    ONE approved base-map host is added to EXTRA_SOURCES and nowhere else.
 */
const EXTRA_SOURCES: { connect: string[]; img: string[] } = { connect: [], img: [] };
const dev = process.env.NODE_ENV !== "production";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src ${["'self'", "data:", "blob:", ...EXTRA_SOURCES.img].join(" ")}`,
  "font-src 'self'",
  `connect-src ${["'self'", ...EXTRA_SOURCES.connect, ...(dev ? ["ws:"] : [])].join(" ")}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  // Browsers ignore this on plain http (local development); on https it forbids going back to http.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
];

const nextConfig: NextConfig = {
  // A second build folder lets the demo-to-real rehearsal (docs/37) build with its own settings
  // without replacing the normal build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  // "/" is answered in src/proxy.ts: Today for a signed-in member, Discover for a visitor (docs/68, L1).
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Private areas are never cacheable, whatever a page or handler does.
      { source: "/account/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/account", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/api/v1/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      // Staff pages, tester feedback and the tester-meal review: never cached, never indexed.
      ...["/editor", "/editor/:path*", "/moderation", "/moderation/:path*", "/feedback", "/feedback/:path*", "/places/menus/testers"].map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      })),
    ];
  },
};

export default nextConfig;
