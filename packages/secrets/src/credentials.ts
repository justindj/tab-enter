import type { CredentialProvider, ProfileSettings, ServiceName } from '@tab-enter/core';
import { SECRET_NAMES, type SecretStore } from './store';

export class MissingCredentialError extends Error {
  constructor(public readonly service: ServiceName) {
    super(`No ${service === 'jira' ? 'Jira' : 'GitLab'} token is stored for this profile.`);
  }
}

/** Personal access tokens from the secret store. OAuth providers can implement the same interface later. */
export class PatCredentialProvider implements CredentialProvider {
  constructor(
    private readonly store: SecretStore,
    private readonly getSettings: (profileId: string) => Promise<ProfileSettings>,
  ) {}

  async getAuthHeaders(profileId: string, service: ServiceName): Promise<Record<string, string>> {
    if (service === 'gitlab') {
      const token = await this.store.get(profileId, SECRET_NAMES.gitlabToken);
      if (!token) throw new MissingCredentialError('gitlab');
      return { 'PRIVATE-TOKEN': token };
    }

    const token = await this.store.get(profileId, SECRET_NAMES.jiraToken);
    if (!token) throw new MissingCredentialError('jira');
    const { jira } = await this.getSettings(profileId);
    if (jira.deployment === 'datacenter') return { Authorization: `Bearer ${token}` };
    if (!jira.email) throw new Error('Jira Cloud needs the account email alongside the API token.');
    return { Authorization: `Basic ${Buffer.from(`${jira.email}:${token}`).toString('base64')}` };
  }
}
