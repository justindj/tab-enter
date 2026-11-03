'use client';

import {
  activeFilterOptions,
  DEFAULT_ACTIVE_FILTERS,
  filterActiveWork,
  groupByStatus,
  MR_STATUS_LABELS,
  MR_STATUS_TONE,
  openMRs,
  sortActiveWork,
  worstMRStatus,
  type ActiveFilters,
  type ActiveSort,
  type IssueView,
  type LinkSource,
  type MRStatus,
  type MRView,
} from '@tab-enter/core';
import { ChevronDown, ChevronRight, Link2, MessageSquare, Unlink, X } from 'lucide-react';
import { Fragment, useId, useMemo, useState, useTransition, type ReactNode } from 'react';
import { setMRLinkAction, type ActionResult } from '@/app/actions';
import { EmptyState } from '@/components/empty-state';
import { MRStatusBadges, PipelineBadge } from '@/components/mr-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/field';
import { timeAgo } from '@/lib/format';
import { useStoredState } from '@/lib/use-stored-state';
import { MoveTicket } from './move-ticket';
import { cn } from '@/lib/utils';

export interface ActiveWorkProps {
  profileId: string;
  views: IssueView[];
  /** My open MRs with no ticket. */
  unlinked: MRView[];
  /** My open MRs, for the "link an MR" picker. */
  myOpenMRs: MRView[];
  sprintDefault: boolean;
  /** Settings → Write actions → Move Jira tickets. */
  allowTransition: boolean;
  now: string;
}

interface ViewPrefs {
  layout: 'grouped' | 'table';
  sort: ActiveSort;
  direction: 'asc' | 'desc';
}

const DEFAULT_PREFS: ViewPrefs = { layout: 'grouped', sort: 'rank', direction: 'asc' };

const SOURCE_LABEL: Record<LinkSource, string> = {
  branch: 'branch',
  title: 'title',
  description: 'description',
  manual: 'manual',
};

/** Runs a link/unlink and reports the outcome in one shared status line. */
function useLinkAction() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult>({});
  const run = (mrKey: string, issueKey: string, linked: boolean) =>
    startTransition(async () => setResult(await setMRLinkAction(mrKey, issueKey, linked)));
  return { pending, result, run };
}

type LinkRun = ReturnType<typeof useLinkAction>['run'];

export function ActiveWork(props: ActiveWorkProps) {
  const now = useMemo(() => new Date(props.now), [props.now]);
  const [prefs, setPrefs] = useStoredState<ViewPrefs>(
    `active-work:view:${props.profileId}`,
    DEFAULT_PREFS,
  );
  const [filters, setFilters] = useStoredState<ActiveFilters>(
    `active-work:filters:${props.profileId}`,
    { ...DEFAULT_ACTIVE_FILTERS, sprintOnly: props.sprintDefault },
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const link = useLinkAction();

  const options = useMemo(() => activeFilterOptions(props.views), [props.views]);
  const scoped = useMemo(
    () =>
      filterActiveWork(props.views, { ...DEFAULT_ACTIVE_FILTERS, sprintOnly: filters.sprintOnly }),
    [props.views, filters.sprintOnly],
  );
  const rows = useMemo(
    () => sortActiveWork(filterActiveWork(props.views, filters), prefs.sort, prefs.direction),
    [props.views, filters, prefs.sort, prefs.direction],
  );
  const filtering =
    filters.text !== '' ||
    filters.statuses.length > 0 ||
    filters.priorities.length > 0 ||
    filters.mr !== 'any' ||
    filters.mrStatus !== null;

  const update = (patch: Partial<ActiveFilters>) => setFilters({ ...filters, ...patch });
  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpanded(next);
  };
  const sortBy = (sort: ActiveSort) =>
    setPrefs({
      ...prefs,
      sort,
      direction:
        sort !== 'rank' && prefs.sort === sort && prefs.direction === 'asc' ? 'desc' : 'asc',
    });

  const rowProps = {
    expanded,
    toggle,
    now,
    myOpenMRs: props.myOpenMRs,
    link,
    allowTransition: props.allowTransition,
  };

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Active Work</h1>
        <div className="flex items-center gap-2">
          <Segmented
            label="Scope"
            value={filters.sprintOnly ? 'sprint' : 'all'}
            options={[
              { value: 'sprint', label: 'Current sprint' },
              { value: 'all', label: 'All' },
            ]}
            onChange={(v) => update({ sprintOnly: v === 'sprint' })}
          />
          <Segmented
            label="Layout"
            value={prefs.layout}
            options={[
              { value: 'grouped', label: 'By status' },
              { value: 'table', label: 'Table' },
            ]}
            onChange={(v) => setPrefs({ ...prefs, layout: v as ViewPrefs['layout'] })}
          />
        </div>
      </div>

      <div
        className="flex flex-wrap items-end gap-2"
        role="search"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && filtering) {
            e.preventDefault();
            setFilters({ ...DEFAULT_ACTIVE_FILTERS, sprintOnly: filters.sprintOnly });
          }
        }}
      >
        <Input
          type="search"
          aria-label="Search tickets and merge requests"
          placeholder="Search key, summary, MR, branch"
          value={filters.text}
          onChange={(e) => update({ text: e.target.value })}
          className="w-64"
        />
        <FilterSelect
          label="Status"
          value={filters.statuses[0] ?? ''}
          onChange={(v) => update({ statuses: v ? [v] : [] })}
          options={options.statuses.map((s) => ({ value: s, label: s }))}
        />
        <FilterSelect
          label="Priority"
          value={filters.priorities[0] ?? ''}
          onChange={(v) => update({ priorities: v ? [v] : [] })}
          options={options.priorities.map((p) => ({ value: p, label: p }))}
        />
        <FilterSelect
          label="Merge request"
          value={filters.mr === 'any' ? '' : filters.mr}
          onChange={(v) => update({ mr: (v || 'any') as ActiveFilters['mr'] })}
          options={[
            { value: 'has', label: 'Has an open MR' },
            { value: 'none', label: 'No open MR' },
          ]}
        />
        <FilterSelect
          label="MR status"
          value={filters.mrStatus ?? ''}
          onChange={(v) => update({ mrStatus: (v || null) as MRStatus | null })}
          options={options.mrStatuses.map((s) => ({ value: s, label: MR_STATUS_LABELS[s] }))}
        />
        {filtering && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setFilters({ ...DEFAULT_ACTIVE_FILTERS, sprintOnly: filters.sprintOnly })
            }
            title="Clear filters (Esc)"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          {rows.length === scoped.length
            ? `${rows.length} ticket${rows.length === 1 ? '' : 's'}`
            : `${rows.length} of ${scoped.length} tickets`}
        </span>
      </div>

      {(link.result.ok || link.result.error) && (
        <p
          role={link.result.error ? 'alert' : 'status'}
          className={cn('text-xs', link.result.error ? 'text-danger' : 'text-success')}
        >
          {link.result.error ?? link.result.ok}
        </p>
      )}

      {rows.length === 0 ? (
        <Card>
          <EmptyState title={filtering ? 'No tickets match these filters' : 'No active tickets'}>
            {filtering
              ? 'Press Esc or Clear to reset.'
              : filters.sprintOnly
                ? 'Nothing assigned to you in the current sprint. Switch to All to see the rest.'
                : 'Nothing assigned to you outside the Done category.'}
          </EmptyState>
        </Card>
      ) : prefs.layout === 'table' ? (
        <Card>
          <IssueTable
            rows={rows}
            sort={prefs.sort}
            direction={prefs.direction}
            onSort={sortBy}
            showStatus
            {...rowProps}
          />
        </Card>
      ) : (
        groupByStatus(rows).map((group) => (
          <Card key={group.status}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  {group.status}
                  <Badge tone="muted">{group.issues.length}</Badge>
                </span>
              }
            />
            <IssueTable
              rows={group.issues}
              sort={prefs.sort}
              direction={prefs.direction}
              onSort={sortBy}
              showStatus={false}
              {...rowProps}
            />
          </Card>
        ))
      )}

      <UnlinkedMRs
        rows={props.unlinked}
        issueKeys={props.views.map((v) => ({ key: v.issue.key, summary: v.issue.summary }))}
        now={now}
        link={link}
      />
    </div>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex rounded-md border p-0.5 text-xs" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded px-2 py-1',
            value === o.value
              ? 'bg-accent font-medium'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn('w-auto min-w-32', value && 'border-primary')}
    >
      <option value="">{label}: all</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

interface RowProps {
  expanded: Set<string>;
  toggle: (key: string) => void;
  now: Date;
  myOpenMRs: MRView[];
  link: ReturnType<typeof useLinkAction>;
  allowTransition: boolean;
}

function IssueTable({
  rows,
  sort,
  direction,
  onSort,
  showStatus,
  ...rowProps
}: RowProps & {
  rows: IssueView[];
  sort: ActiveSort;
  direction: 'asc' | 'desc';
  onSort: (sort: ActiveSort) => void;
  showStatus: boolean;
}) {
  const header = (label: string, key: ActiveSort | null, className = '') => (
    <th
      className={cn('px-2 py-2 font-medium', className)}
      aria-sort={
        key && sort === key ? (direction === 'asc' ? 'ascending' : 'descending') : undefined
      }
    >
      {key ? (
        <button
          type="button"
          onClick={() => onSort(key)}
          className={cn('hover:text-foreground', sort === key && 'text-foreground')}
        >
          {label}
          {sort === key && (direction === 'asc' ? ' ↑' : ' ↓')}
        </button>
      ) : (
        label
      )}
    </th>
  );
  const columns = showStatus ? 7 : 6;
  return (
    <div className="overflow-x-auto">
      {/* Fixed widths so columns line up across the per-status cards. */}
      <table className="w-full min-w-[860px] table-fixed text-sm">
        <colgroup>
          <col className="w-9" />
          <col className="w-24" />
          <col />
          {showStatus && <col className="w-28" />}
          <col className="w-20" />
          <col className="w-48" />
          <col className="w-20" />
        </colgroup>
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="py-2 pl-3" aria-label="Expand" />
            {header('Ticket', 'key')}
            <th className="px-2 py-2 font-medium">
              Summary
              {sort !== 'rank' && (
                <button
                  type="button"
                  onClick={() => onSort('rank')}
                  className="ml-2 font-normal underline-offset-2 hover:text-foreground hover:underline"
                  title="Sort by Jira rank (the backlog order)"
                >
                  back to Jira order
                </button>
              )}
            </th>
            {showStatus && header('Status', 'status')}
            {header('Priority', 'priority')}
            {header('Merge requests', null)}
            {header('Updated', 'updated', 'pr-4 text-right')}
          </tr>
        </thead>
        <tbody>
          {rows.map((view) => (
            <IssueRow
              key={view.issue.key}
              view={view}
              showStatus={showStatus}
              columns={columns}
              {...rowProps}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IssueRow({
  view,
  showStatus,
  columns,
  expanded,
  toggle,
  now,
  myOpenMRs,
  link,
  allowTransition,
}: RowProps & { view: IssueView; showStatus: boolean; columns: number }) {
  const { issue } = view;
  const open = expanded.has(issue.key);
  const openCount = openMRs(view).length;
  const worst = worstMRStatus(view);
  const detailsId = `details-${issue.key}`;
  return (
    <Fragment>
      <tr
        className={cn('border-b align-top hover:bg-muted/50', open && 'bg-muted/30')}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('a, button')) toggle(issue.key);
        }}
      >
        <td className="py-2 pl-3">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${issue.key}`}
            onClick={() => toggle(issue.key)}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </td>
        <td className="px-2 py-2">
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs whitespace-nowrap hover:underline"
          >
            {issue.key}
          </a>
        </td>
        <td className="px-2 py-2">
          {issue.summary}
          {!issue.inOpenSprint && (
            <Badge tone="muted" className="ml-2">
              Not in sprint
            </Badge>
          )}
        </td>
        {showStatus && <td className="px-2 py-2 text-xs whitespace-nowrap">{issue.status}</td>}
        <td className="px-2 py-2 text-xs whitespace-nowrap">{issue.priority ?? '—'}</td>
        <td className="px-2 py-2 whitespace-nowrap">
          {openCount === 0 ? (
            <Badge tone="warning" title="No open merge request linked to this ticket">
              No MR
            </Badge>
          ) : (
            <span className="flex items-center gap-1.5">
              <Badge tone={MR_STATUS_TONE[worst!]}>{MR_STATUS_LABELS[worst!]}</Badge>
              {openCount > 1 && (
                <span className="text-xs text-muted-foreground">{openCount} MRs</span>
              )}
            </span>
          )}
        </td>
        <td className="px-2 py-2 pr-4 text-right text-xs whitespace-nowrap text-muted-foreground">
          {timeAgo(issue.updatedAt, now)}
        </td>
      </tr>
      {open && (
        <tr id={detailsId} className="border-b bg-muted/30">
          <td />
          <td colSpan={columns - 1} className="px-2 pt-1 pb-3">
            <IssueDetails
              view={view}
              myOpenMRs={myOpenMRs}
              now={now}
              link={link}
              allowTransition={allowTransition}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function IssueDetails({
  view,
  myOpenMRs,
  now,
  link,
  allowTransition,
}: {
  view: IssueView;
  myOpenMRs: MRView[];
  now: Date;
  link: RowProps['link'];
  allowTransition: boolean;
}) {
  const { issue, mrs } = view;
  const candidates = myOpenMRs.filter((m) => !m.issueKeys.includes(issue.key));
  const pickerId = useId();
  const [pick, setPick] = useState('');
  return (
    <div className="grid gap-3">
      {mrs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No merge requests linked to this ticket.</p>
      ) : (
        <ul className="grid gap-2">
          {mrs.map((m) => (
            <MRLine
              key={m.key}
              view={m}
              now={now}
              source={m.links.find((l) => l.issueKey === issue.key)?.source}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={link.pending}
                  onClick={() => link.run(m.key, issue.key, false)}
                  title={`Unlink !${m.mr.ref.iid} from ${issue.key}. Stays unlinked after syncs.`}
                >
                  <Unlink className="h-3.5 w-3.5" /> Unlink
                </Button>
              }
            />
          ))}
        </ul>
      )}

      {candidates.length > 0 && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pick) link.run(pick, issue.key, true);
            setPick('');
          }}
        >
          <label htmlFor={pickerId} className="text-xs text-muted-foreground">
            Link one of my open MRs
          </label>
          <Select
            id={pickerId}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="w-auto max-w-md"
          >
            <option value="">Choose…</option>
            {candidates.map((m) => (
              <option key={m.key} value={m.key}>
                !{m.mr.ref.iid} {m.mr.title}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline" size="sm" disabled={!pick || link.pending}>
            <Link2 className="h-3.5 w-3.5" /> Link
          </Button>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <a
          href={`/runs?issue=${encodeURIComponent(issue.key)}`}
          className="text-muted-foreground underline-offset-2 hover:underline"
        >
          Claude Code runs for {issue.key}
        </a>
        <MoveTicket issueKey={issue.key} status={issue.status} allowed={allowTransition} />
      </div>
    </div>
  );
}

function MRLine({
  view,
  now,
  source,
  action,
}: {
  view: MRView;
  now: Date;
  source?: LinkSource;
  action?: ReactNode;
}) {
  const { mr } = view;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-card px-3 py-2">
      <span className="min-w-0 flex-1">
        <a href={mr.webUrl} target="_blank" rel="noreferrer" className="hover:underline">
          {mr.title}
        </a>
        <span className="block text-xs text-muted-foreground">
          !{mr.ref.iid} · {mr.projectPath} · <code>{mr.sourceBranch}</code> · +{mr.linesAdded} −
          {mr.linesRemoved} · updated {timeAgo(mr.updatedAt, now)}
        </span>
      </span>
      {source && (
        <Badge tone="muted" title={`Linked by ${SOURCE_LABEL[source]}`}>
          via {SOURCE_LABEL[source]}
        </Badge>
      )}
      <MRStatusBadges status={view.status} />
      <PipelineBadge status={mr.pipelineStatus} />
      <span className="text-xs tabular-nums" title="Approvals">
        {mr.approvedBy.length}/{Math.max(1, mr.approvalsRequired)} approvals
      </span>
      {mr.unresolvedThreads > 0 && (
        <span
          className="inline-flex items-center gap-1 text-xs text-warning"
          title="Unresolved threads"
        >
          <MessageSquare className="h-3 w-3" /> {mr.unresolvedThreads}
        </span>
      )}
      {action}
    </li>
  );
}

function UnlinkedMRs({
  rows,
  issueKeys,
  now,
  link,
}: {
  rows: MRView[];
  issueKeys: { key: string; summary: string }[];
  now: Date;
  link: RowProps['link'];
}) {
  const listId = useId();
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title="Unlinked merge requests"
        description="My open MRs not linked to any ticket. Link them by hand; manual links survive syncs."
      />
      <datalist id={listId}>
        {issueKeys.map((i) => (
          <option key={i.key} value={i.key}>
            {i.summary}
          </option>
        ))}
      </datalist>
      <ul className="grid gap-2 p-3">
        {rows.map((m) => (
          <MRLine
            key={m.key}
            view={m}
            now={now}
            action={<LinkToTicket mr={m} listId={listId} run={link.run} pending={link.pending} />}
          />
        ))}
      </ul>
    </Card>
  );
}

function LinkToTicket({
  mr,
  listId,
  run,
  pending,
}: {
  mr: MRView;
  listId: string;
  run: LinkRun;
  pending: boolean;
}) {
  const [key, setKey] = useState('');
  return (
    <span className="flex flex-wrap items-center gap-2">
      {mr.unlinkedKeys.map((k) => (
        <Button
          key={k}
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => run(mr.key, k, true)}
          title={`You unlinked ${k}. Restore the automatic link.`}
        >
          Restore {k}
        </Button>
      ))}
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) run(mr.key, key, true);
          setKey('');
        }}
      >
        <Input
          list={listId}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Ticket key"
          aria-label={`Ticket key to link to !${mr.mr.ref.iid}`}
          className="h-7 w-32 font-mono text-xs uppercase"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!key.trim() || pending}>
          <Link2 className="h-3.5 w-3.5" /> Link
        </Button>
      </form>
    </span>
  );
}
