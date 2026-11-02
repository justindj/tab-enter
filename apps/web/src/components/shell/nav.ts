export interface NavItem {
  href: string;
  label: string;
  /** Second key of the `g <key>` shortcut. */
  key: string;
  countKey?: 'now' | 'active' | 'review';
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Now', key: 'n', countKey: 'now' },
  { href: '/active', label: 'Active Work', key: 'a', countKey: 'active' },
  { href: '/verification', label: 'Verification', key: 'v' },
  { href: '/communication', label: 'Communication', key: 'c' },
  { href: '/review', label: 'Code Review', key: 'r', countKey: 'review' },
  { href: '/settings', label: 'Settings', key: 's' },
];
