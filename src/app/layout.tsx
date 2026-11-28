import type { Metadata, Viewport } from "next";
import { TimezoneSync } from "@/components/diary/timezone-sync";
import { Suspense } from "react";
import { NavProgress } from "@/components/nav-progress";
import { OfflineNotice } from "@/components/offline-notice";
import { BRAND } from "@/config/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.tagline,
  robots: { index: false, follow: false },
};

// "cover" lets the page reach the screen edges on iPhones, so env(safe-area-inset-*) has real
// values and the tab bar, cooking buttons and map sheet keep clear of the home bar (MAP-1.1).
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <OfflineNotice />
        <Suspense fallback={null}>
          <NavProgress />
        </Suspense>
        {children}
        <TimezoneSync />
      </body>
    </html>
  );
}
