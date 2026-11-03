import type { CredentialProvider, ProfileSettings } from '@tab-enter/core';
import { GitLabCodeHost } from './gitlab';
import type { FetchLike } from './http';
import { JiraIssueTracker } from './jira';
import { ConnectorError } from './types';

export interface LiveConnectorOptions {
  profileId: string;
  settings: ProfileSettings;
  credentials: CredentialProvider;
  /** How far back completed reviews and merged MRs go. */
  completedSince?: Date;
  fetch?: FetchLike;
  now?: () => Date;
}

export function createJiraTracker(opts: LiveConnectorOptions): JiraIssueTracker {
  const { jira } = opts.settings;
  if (!jira.baseUrl) {
    throw new ConnectorError('other', 'Jira is not configured: add its URL in Settings.');
  }
  return new JiraIssueTracker({
    deployment: jira.deployment,
    baseUrl: jira.baseUrl,
    boardId: jira.boardId || undefined,
    doneStatuses: jira.doneStatuses,
    getHeaders: () => opts.credentials.getAuthHeaders(opts.profileId, 'jira'),
    fetch: opts.fetch,
    now: opts.now,
  });
}

export function createGitLabHost(opts: LiveConnectorOptions): GitLabCodeHost {
  const { gitlab } = opts.settings;
  if (!gitlab.baseUrl) {
    throw new ConnectorError('other', 'GitLab is not configured: add its URL in Settings.');
  }
  return new GitLabCodeHost({
    baseUrl: gitlab.baseUrl,
    projects: gitlab.projects,
    completedSince: opts.completedSince,
    getHeaders: () => opts.credentials.getAuthHeaders(opts.profileId, 'gitlab'),
    fetch: opts.fetch,
  });
}
