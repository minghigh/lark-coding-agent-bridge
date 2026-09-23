import type { ProfileConfig } from '../config/profile-schema';
import type { ScopeContext } from '../policy/run-policy';

export function sessionScopeFor(
  _profile: ProfileConfig,
  scope: string,
  _source: ScopeContext['source'] = 'im',
): string {
  return scope;
}

export function policyScopeFor(
  _profile: ProfileConfig,
  scope: ScopeContext,
): ScopeContext {
  return scope;
}
