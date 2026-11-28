"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Tells the server which timezone this browser is in, so "today" in the diary is
 * the person's own calendar day. It stores only the timezone name (for example
 * "America/New_York") in a first-party cookie; no location is read. It runs on
 * every page so the diary already knows the timezone on its first visit.
 */
export function TimezoneSync() {
  const router = useRouter();
  useEffect(() => {
    let zone = "";
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      return;
    }
    if (!zone) return;
    const current = document.cookie.split("; ").find((c) => c.startsWith("tz="))?.slice(3);
    if (current === encodeURIComponent(zone)) return;
    document.cookie = `tz=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax`;
    // Only pages that show "today" depend on it; refreshing is cheap and keeps them right.
    if (window.location.pathname.startsWith("/diary")) router.refresh();
  }, [router]);
  return null;
}
