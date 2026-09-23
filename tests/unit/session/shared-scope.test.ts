import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { policyScopeFor, sessionScopeFor } from '../../../src/session/shared-scope';

describe('chat session isolation', () => {
  it('keeps private chats, groups, and topics separate even with a legacy shared flag', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
      codex: { binaryPath: 'codex' },
    });
    Object.assign(profile.codex!, { sharedSession: true });

    expect(sessionScopeFor(profile, 'oc_private')).toBe('oc_private');
    expect(sessionScopeFor(profile, 'oc_group')).toBe('oc_group');
    expect(sessionScopeFor(profile, 'oc_group:om_topic')).toBe('oc_group:om_topic');
    expect(sessionScopeFor(profile, 'comment:doc')).toBe('comment:doc');

    const scope = { source: 'im' as const, chatId: 'oc_group', actorId: 'ou_user', threadId: 'om_topic' };
    expect(policyScopeFor(profile, scope)).toEqual(scope);
  });
});
