import Link from "next/link";
import { Suspense } from "react";
import { getPreviewAudience } from "@/server/catalog/menu-preview";
import { BRAND } from "@/config/brand";
import { FLAGS } from "@/config/flags";
import { Icon, type IconName } from "./icons";

export type Section = "today" | "discover" | "protein" | "diary" | "goals" | "cook" | "friends" | "saved" | "account" | "none";

/** Phones: five tabs. Today, the diary and goals share one tab (owner decision 2026-11-13; Today added, docs/68 L1). */
const TABS: { key: Section; href: string; label: string; icon: IconName }[] = [
  { key: "discover", href: "/discover", label: "Discover", icon: "discover" },
  { key: "protein", href: "/protein", label: "Protein", icon: "protein" },
  { key: "today", href: "/today", label: "Today", icon: "diary" },
  { key: "cook", href: "/cook", label: "Cook", icon: "cook" },
  { key: "friends", href: "/friends", label: "Friends", icon: "friends" },
];
/** Wider screens have room for all six pillars. */
const SIDE: { key: Section; href: string; label: string; icon: IconName; id?: string }[] = [
  { key: "today", href: "/today", label: "Today", icon: "goals" },
  { key: "discover", href: "/discover", label: "Discover", icon: "discover" },
  { key: "protein", href: "/protein", label: "Protein Explorer", icon: "protein" },
  { key: "diary", href: "/diary", label: "Food Diary", icon: "diary" },
  { key: "goals", href: "/diary/goals", label: "Goals", icon: "goals" },
  { key: "cook", href: "/cook", label: "Recipes & Cook", icon: "cook" },
  { key: "friends", href: "/friends", label: "Friends & Lists", icon: "friends" },
];

/**
 * `realPlaces`: the page shows real places from public datasets (docs/36), so the demo banner must not
 * call them invented.
 */
export function AppShell({ active, narrow = false, realPlaces = false, children }: { active: Section; narrow?: boolean; realPlaces?: boolean; children: React.ReactNode }) {
  const current = (key: Section) => (key === active ? ("page" as const) : undefined);
  // On phones Today, the diary and goals share one tab, so that tab is current for all three.
  const currentTab = (key: Section) => (key === active || (key === "today" && (active === "diary" || active === "goals")) ? ("page" as const) : undefined);
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="side">
        <Link className="brand" href="/discover">
          {BRAND.name}
        </Link>
        <nav aria-label="Sections" className="stack-nav">
          {SIDE.map((item) => (
            <Link key={item.label} className="nav" href={item.href} aria-current={current(item.key)}>
              <Icon name={item.icon} />
              {item.label}
            </Link>
          ))}
        </nav>
        <span className="grow" />
        <Link className="nav" href="/saved" aria-current={current("saved")}>
          <Icon name="save" />
          Saved
        </Link>
        <Link className="nav" href="/account" aria-current={current("account")}>
          <Icon name="user" />
          Account
        </Link>
        {FLAGS.allowDemoContent && !realPlaces && <p className="note">Demo data. Places, dishes and numbers are invented.</p>}
      </aside>
      <div className="main-col">
        <header className="topbar">
          <Link className="brand" href="/discover">
            {BRAND.name}
          </Link>
          <span className="links">
            <Link className="icon-link" href="/saved" aria-current={current("saved")}>
              <Icon name="save" />
              <span className="icon-label">Saved</span>
            </Link>
            <Link className="icon-link" href="/account" aria-current={current("account")}>
              <Icon name="user" />
              <span className="icon-label">Account</span>
            </Link>
          </span>
        </header>
        {realPlaces ? (
          <Suspense fallback={null}>
            <RealBanner />
          </Suspense>
        ) : (
          FLAGS.allowDemoContent && (
            <p className="demo-banner" role="note">
              <strong>Demo data.</strong> Every place, dish and number here is invented for testing.
            </p>
          )
        )}
        <main id="main" className={`content ${narrow ? "narrow" : ""}`}>
          {children}
        </main>
      </div>
      <nav className="tabbar" aria-label="Primary">
        {TABS.map((tab) => (
          <Link key={tab.key} href={tab.href} aria-current={currentTab(tab.key)}>
            <Icon name={tab.icon} className="" />
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** Shown while request-time content loads. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="muted" role="status">
      {label}
    </p>
  );
}

/**
 * The real-mode note (bug B1, docs/68). Only the founder sees the private preview, so only the founder is told
 * the places are private to them. Anyone else sees no real listing until publication, so the note is left out
 * rather than describing something they cannot see.
 */
async function RealBanner() {
  const audience = await getPreviewAudience().catch(() => null);
  if (audience === "member_beta")
    return (
      <p className="demo-banner" role="note" data-testid="real-banner">
        <strong>Local beta.</strong> A few real Boston-area restaurants, for test accounts on this computer only.
      </p>
    );
  if (audience !== "founder") return FLAGS.allowDemoContent ? <p className="demo-banner" role="note"><strong>Demo data.</strong> Other pages use invented demo data.</p> : null;
  return (
    <p className="demo-banner" role="note" data-testid="real-banner">
      <strong>Private preview.</strong> Only you can see these real places and meals; nothing here is public.
      {FLAGS.allowDemoContent ? " Other pages still use invented demo data." : ""}
    </p>
  );
}
