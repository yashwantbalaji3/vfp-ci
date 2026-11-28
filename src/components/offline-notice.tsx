"use client";
import { useEffect, useState } from "react";

/**
 * Tells the person, in words, when the browser has lost its connection (audit A1-11).
 * Without this a press simply appears to do nothing. Nothing is queued or retried in
 * the background: the notice says plainly that changes cannot be saved until the
 * connection is back, and disappears when it returns.
 */
export function OfflineNotice() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return (
    <div role="status" aria-live="polite">
      {offline && (
        <p className="offline-notice" data-testid="offline-notice">
          <strong>You&rsquo;re offline.</strong> Pages may not load and changes can&rsquo;t be saved until your connection is back.
        </p>
      )}
    </div>
  );
}
