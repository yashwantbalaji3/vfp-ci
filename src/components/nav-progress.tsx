"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * A thin "Loading…" bar while the next page is on its way (owner direction 22 Nov 2026: loading states and slow
 * networks). On a slow connection a tap on a link otherwise leaves the old page on screen with no sign that anything
 * is happening. It appears only after 200 ms, so a fast navigation never flashes it, and it goes away as soon as the
 * new address is showing (or after 20 s, so it can never get stuck). Nothing is retried or queued.
 */
export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const here = `${pathname}?${search.toString()}`;
  // The address the person was on when the bar started: once the address changes, the bar is no longer shown.
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const pending = pendingFrom !== null && pendingFrom === here;
  const timers = useRef<number[]>([]);
  const clear = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      clear();
      const from = `${window.location.pathname}?${window.location.search.replace(/^\?/, "")}`;
      timers.current.push(window.setTimeout(() => setPendingFrom(from), 200), window.setTimeout(() => setPendingFrom(null), 20_000));
    };
    // Capture phase: Next's <Link> cancels the browser's own navigation (preventDefault) before a bubbling
    // listener would see the click, so listen on the way down instead.
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      clear();
    };
  }, []);
  return (
    <div role="status" aria-live="polite" className="nav-progress-wrap">
      {pending && (
        <p className="nav-progress" data-testid="nav-progress">
          <span className="nav-progress-bar" aria-hidden="true" />
          Loading&hellip;
        </p>
      )}
    </div>
  );
}
