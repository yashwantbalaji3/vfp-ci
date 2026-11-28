/**
 * Sign-in cookies get the Secure flag whenever the app is served over https (release audit 23 Nov 2026, docs/75
 * item 5), so a session cookie is never sent over plain http. Local development on http://localhost keeps the
 * library defaults, because Safari refuses Secure cookies on plain-http localhost.
 */
export function withSecureFlag<T extends object>(options: T | undefined): T {
  const https = (process.env.NEXT_PUBLIC_APP_URL ?? "").startsWith("https://");
  return (https ? { ...(options ?? {}), secure: true } : (options ?? {})) as T;
}
