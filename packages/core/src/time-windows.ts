import type { ProfileSettings } from './settings';

// The daily report's reporting window (spec section 4.8). Days are the local
// days of the machine tab-enter runs on, which is the developer's own.

export type DailyReportWindowSettings = ProfileSettings['timeWindows']['dailyReport'];

export interface ReportWindow {
  start: Date;
  end: Date;
  /** Human description, e.g. "since Friday 09:30" or "last 24 hours". */
  label: string;
}

const HOUR = 3_600_000;

/**
 * How far back syncs fetch completed tickets and merged MRs: the display
 * retention, but at least a week so a Monday or "since last report" daily
 * report still has its Done items.
 */
export function completedSyncDays(settings: Pick<ProfileSettings, 'timeWindows'>): number {
  return Math.max(settings.timeWindows.recentRetentionDays, 7);
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Friday 09:30" within the last week, else "2026-10-28 09:30". */
export function describeTime(d: Date, now: Date): string {
  const ageDays = (now.getTime() - d.getTime()) / (24 * HOUR);
  if (ageDays < 6) return `${DAYS[d.getDay()]} ${hhmm(d)}`;
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${date} ${hhmm(d)}`;
}

/**
 * Where the report starts.
 * - last24h: 24 hours back; on a Monday (when enabled) back to the same time on Friday.
 * - sinceLastReport: from the last report you copied, else as last24h.
 * - sinceDate: from a chosen date/time, else as last24h.
 * - customHours: that many hours back.
 */
export function dailyReportWindow(
  settings: DailyReportWindowSettings,
  now: Date,
  lastReportAt: Date | null,
): ReportWindow {
  const last24h = (): ReportWindow => {
    if (settings.mondayCoversWeekend && now.getDay() === 1) {
      const start = new Date(now.getTime() - 72 * HOUR);
      return { start, end: now, label: `since ${describeTime(start, now)} (covers the weekend)` };
    }
    return { start: new Date(now.getTime() - 24 * HOUR), end: now, label: 'last 24 hours' };
  };

  switch (settings.mode) {
    case 'sinceLastReport':
      return lastReportAt && lastReportAt < now
        ? {
            start: lastReportAt,
            end: now,
            label: `since your last report (${describeTime(lastReportAt, now)})`,
          }
        : { ...last24h(), label: `${last24h().label} (no earlier report)` };
    case 'sinceDate': {
      const start = settings.sinceDate ? new Date(settings.sinceDate) : null;
      return start && !Number.isNaN(start.getTime()) && start < now
        ? { start, end: now, label: `since ${describeTime(start, now)}` }
        : last24h();
    }
    case 'customHours': {
      const hours = settings.customHours ?? 24;
      return {
        start: new Date(now.getTime() - hours * HOUR),
        end: now,
        label: `last ${hours} hours`,
      };
    }
    default:
      return last24h();
  }
}
