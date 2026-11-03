import {
  buildDailyReport,
  buildReviewRequest,
  completedSyncDays,
  dailyReportWindow,
  renderDailyReport,
  renderReviewRequest,
  type DailyReportWindowSettings,
} from '@tab-enter/core';
import { getDb, lastDailyReportAt, listMessages } from '@tab-enter/db';
import { Suspense } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Card, CardHeader } from '@/components/ui/card';
import { loadNow } from '@/lib/data';
import { plural } from '@/lib/format';
import { Composer, HistoryList } from './composer';
import { WindowPicker } from './window-picker';

type Search = { window?: string; hours?: string; since?: string };

/** The Settings window, optionally overridden for this report by the URL. */
function windowSettings(base: DailyReportWindowSettings, q: Search): DailyReportWindowSettings {
  switch (q.window) {
    case 'last24h':
    case 'sinceLastReport':
      return { ...base, mode: q.window };
    case 'customHours': {
      const hours = Number(q.hours);
      return Number.isFinite(hours) && hours > 0
        ? { ...base, mode: 'customHours', customHours: hours }
        : base;
    }
    case 'sinceDate':
      return q.since ? { ...base, mode: 'sinceDate', sinceDate: q.since } : base;
    default:
      return base;
  }
}

export default async function CommunicationPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const q = await searchParams;
  const { workspace, active, now, suggestions, runBlocker } = await loadNow();
  const db = await getDb();
  const [lastReport, history] = await Promise.all([
    lastDailyReportAt(db, active.id),
    listMessages(db, active.id),
  ]);
  const { settings } = active;

  const window = dailyReportWindow(
    windowSettings(settings.timeWindows.dailyReport, q),
    now,
    lastReport,
  );
  const report = buildDailyReport({
    workspace,
    settings,
    suggestions,
    window,
    now,
    syncedSince: new Date(now.getTime() - completedSyncDays(settings) * 86_400_000),
  });
  const dailyTemplate = settings.messageTemplates['daily-report'];
  const reviewItems = buildReviewRequest(workspace, now);
  const reviewTemplate = settings.messageTemplates['review-request'];

  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <div>
        <h1 className="text-lg font-semibold">Communication</h1>
        <p className="text-xs text-muted-foreground">
          Generated from your synced data and templates (Settings), with no AI. Edit freely before
          copying; copied messages are kept in History.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Daily report"
          description={
            <>
              Done / In progress / Next / Blockers, {window.label}.
              {report.syncedSince && (
                <span className="text-warning">
                  {' '}
                  Done only reaches back {completedSyncDays(settings)} days (what sync keeps).
                </span>
              )}
            </>
          }
          actions={
            <Suspense>
              <WindowPicker />
            </Suspense>
          }
        />
        <div className="p-3">
          <Composer
            title="Daily report"
            polishBlocker={runBlocker}
            message={{
              kind: 'daily-report',
              slack: renderDailyReport(report, dailyTemplate, 'slack', now),
              plain: renderDailyReport(report, dailyTemplate, 'plain', now),
              windowStart: window.start.toISOString(),
              windowEnd: window.end.toISOString(),
            }}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Review request"
          description={
            reviewItems.length
              ? `${plural(reviewItems.length, 'open merge request')} of mine waiting for approval, oldest first.`
              : 'None of your open merge requests need a review right now.'
          }
        />
        {reviewItems.length > 0 && (
          <div className="p-3">
            <Composer
              title="Review request"
              polishBlocker={runBlocker}
              message={{
                kind: 'review-request',
                slack: renderReviewRequest(reviewItems, reviewTemplate, 'slack'),
                plain: renderReviewRequest(reviewItems, reviewTemplate, 'plain'),
                windowStart: null,
                windowEnd: null,
              }}
            />
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="History" description="The last 30 messages you copied, newest first." />
        {history.length === 0 ? (
          <EmptyState title="Nothing copied yet" />
        ) : (
          <HistoryList
            items={history.map((m) => ({
              id: m.id,
              kind: m.kind,
              format: m.format,
              body: m.body,
              createdAt: m.createdAt.toISOString(),
            }))}
          />
        )}
      </Card>
    </div>
  );
}
