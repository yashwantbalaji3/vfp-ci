import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { adoptGuestDietOnSignIn } from "@/server/catalog/diet";
import { safeReturnPath } from "@/lib/format";
import { isConfirmed, readEligibility } from "@/server/eligibility";

/** Only same-site relative paths are allowed as post-login destinations (no open redirects; shared check). */
const safeNext = (next: string | null) => safeReturnPath(next, "/account");

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));
  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Best effort: sign-in still succeeds if this fails, and the guest choice stays in the cookie.
      await adoptGuestDietOnSignIn().catch(() => {});
      // Adults-only beta: a member who has not yet confirmed they are 18 or older and agreed to the current Terms and
      // Privacy version sees "Before you start" first (migration 20261126000200).
      const eligibility = await readEligibility(supabase);
      const to = eligibility && !isConfirmed(eligibility) ? `/welcome?next=${encodeURIComponent(next)}` : next;
      const res = NextResponse.redirect(new URL(to, url.origin));
      res.headers.set("Cache-Control", "private, no-store");
      return res;
    }
  }
  return NextResponse.redirect(new URL("/login?error=link", url.origin));
}
