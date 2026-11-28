/** Line icons drawn for this project (design/d1-r2). Decorative: always paired with text. */
const PATHS = {
  discover: <><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5 21 21" /></>,
  protein: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  diary: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  cook: <path d="M4 11h16v3a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6zM8 4c0 2 2 2 2 4M13 4c0 2 2 2 2 4" />,
  friends: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></>,
  goals: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /></>,
  back: <path d="M15 5 8 12l7 7" />,
  next: <path d="m9 5 7 7-7 7" />,
  source: <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h4" />,
  ok: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /></>,
  ask: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17.5v.01" /></>,
  no: <><circle cx="12" cy="12" r="9" /><path d="M6 6l12 12" /></>,
  save: <path d="M6 4h12v17l-6-4-6 4z" />,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  pin: <><path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "icon" }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
