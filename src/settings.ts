import { Env, GlobalSettings } from './types';

const DEFAULT_SETTINGS: GlobalSettings = { defaultUA: 'clash.meta', fetchTimeout: 15, filterEnabled: true };

export async function getGlobalSettings(env: Env): Promise<GlobalSettings> {
  const raw = await env.KV.get('global-settings');
  return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
}
