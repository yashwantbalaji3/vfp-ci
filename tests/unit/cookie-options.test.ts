import { afterEach, describe, expect, it } from "vitest";
import { withSecureFlag } from "@/lib/supabase/cookie-options";

const before = process.env.NEXT_PUBLIC_APP_URL;
afterEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = before;
});

describe("withSecureFlag (docs/75 item 5)", () => {
  it("marks sign-in cookies Secure on an https deployment", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://example.vercel.app";
    expect(withSecureFlag({ path: "/", sameSite: "lax" as const })).toEqual({ path: "/", sameSite: "lax", secure: true });
    expect(withSecureFlag(undefined)).toEqual({ secure: true });
  });
  it("leaves plain-http localhost alone, so Safari keeps the session in local testing", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    expect(withSecureFlag({ path: "/" })).toEqual({ path: "/" });
  });
});
