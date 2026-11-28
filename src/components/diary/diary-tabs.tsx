import Link from "next/link";

/**
 * Today, Day, Week and Goals share one phone tab (owner decision 2026-11-13 put Diary and Goals together; Today
 * joined them as the front of that tab, docs/68 L1).
 */
export function DiaryTabs({ active, date }: { active: "today" | "day" | "week" | "goals"; date?: string }) {
  const q = date ? `?date=${date}` : "";
  const tabs = [
    { key: "today", href: "/today", label: "Today" },
    { key: "day", href: `/diary${q}`, label: "Day" },
    { key: "week", href: `/diary/week${q}`, label: "Week" },
    { key: "goals", href: "/diary/goals", label: "Goals" },
  ] as const;
  return (
    <nav className="seg" aria-label="Your day" style={{ marginBottom: 16 }}>
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} aria-current={t.key === active ? "true" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function SignInPanel({ next, children }: { next: string; children: React.ReactNode }) {
  return (
    <div className="panel" data-testid="diary-signin">
      <p style={{ marginTop: 0 }}>{children}</p>
      <Link className="btn primary" href={`/login?next=${encodeURIComponent(next)}`}>
        Sign in
      </Link>
    </div>
  );
}

export function PrivacyNote() {
  return (
    <p className="s13 muted" style={{ marginTop: 24 }}>
      Private to you. Friends and followers can never see your diary, goals or your own foods.
    </p>
  );
}
