// Line icons of the admin menu: prototype B's set (24px grid, 1.4 stroke, currentColor) plus the few the real menu
// needs that B's demo did not have (inbox, home, tag, settings, logout, card, chat).
const PATHS = {
  grid: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"],
  book: ["M12 5v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2V4Z"],
  calendar: ["M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z", "M7 2v6m10-6v6M3 11h18"],
  user: ["M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M4 22v-3a8 8 0 0 1 16 0v3"],
  users: ["M9 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z", "M2 21v-1.5a7 7 0 0 1 14 0V21", "M15.5 4.3a3.5 3.5 0 0 1 0 6.4", "M18 14a6.5 6.5 0 0 1 4 6v1"],
  clipboard: ["M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2", "M9 2h6v4H9z", "m8.5 14 2.5 2.5L16 11"],
  card: ["M3 6h18v12H3z", "M3 10h18", "M7 15h4"],
  chat: ["M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-9l-5 4v-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z", "M8 9.5h8M8 12.5h5"],
  inbox: ["M3 13h5l2 3h4l2-3h5", "M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6l2.5-8Z"],
  flower: ["M12 12C-2 9 7-5 12 9c5-14 14 0 0 3 14 3 5 17 0 3-5 14-14 0 0-3Z"],
  home: ["M3 11 12 4l9 7", "M5 9.5V20h5v-6h4v6h5V9.5"],
  edit: ["m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 15v5Z"],
  tag: ["M3 12V4h8l10 10-8 8L3 12Z", "M7.5 8.5h.01"],
  mail: ["M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z", "m3 6 9 7 9-7"],
  settings: ["M4 7h9M17 7h3M4 17h3M11 17h9", "M15 5v4", "M9 15v4"],
  up: ["M6 18 18 6M6 6h12v12"],
  logout: ["M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3", "M10 8l-4 4 4 4", "M6 12h10"],
  menu: ["M4 8h16M4 16h16"],
  close: ["m6 6 12 12M6 18 18 6"],
  arrow: ["M4 12h15m-6-6 6 6-6 6"],
} as const;

export type AdminIconName = keyof typeof PATHS;

export function AdminIcon({ name, size = 18, className }: { name: AdminIconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
