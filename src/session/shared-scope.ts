import type { ProfileConfig } from '../config/profile-schema';
import type { ScopeContext } from '../policy/run-policy';

export const SHARED_CODEX_SESSION_SCOPE = '__lark_channel_codex_shared__';

export function sessionScopeFor(
  profile: ProfileConfig,
  scope: string,
  source: ScopeContext['source'] = 'im',
): string {
  return source === 'im' && profile.agentKind === 'codex' && profile.codex?.sharedSession === true
    ? SHARED_CODEX_SESSION_SCOPE
    : scope;
}

export function policyScopeFor(
  profile: ProfileConfig,
  scope: ScopeContext,
): ScopeContext {
  if (
    profile.agentKind !== 'codex' ||
    profile.codex?.sharedSession !== true ||
    scope.source !== 'im'
  ) {
    return scope;
  }
  return {
    ...scope,
    chatId: SHARED_CODEX_SESSION_SCOPE,
    threadId: undefined,
    commentScopeId: undefined,
  };
}
