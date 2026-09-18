import { ProxyNode } from '../types';
import { RoutingProfile } from './routing-profile';

export const DESIRED_CONFIG_SCHEMA_VERSION = 2 as const;

export type UpstreamFetchMode = 'server' | 'mirror' | 'disabled';

export interface UpstreamDefinition {
  id: string;
  name: string;
  url: string;
  userAgent: string;
  prefix: string;
  exclude?: string;
  fetchMode: UpstreamFetchMode;
  required: boolean;
  providerOptions: Record<string, unknown>;
}

export interface MaterializedPolicy {
  routingProfile?: RoutingProfile;
  filterUpstreamInfoNodes: boolean;
  missingCache: 'fail' | 'serve-stale';
  maxCacheAgeSeconds: number;
  domesticNameservers?: string[];
  foreignNameservers?: string[];
  tunRouteExcludeAddresses?: string[];
  dnsFakeIpFilterAppend?: string[];
}

export interface DesiredConfigDraft {
  schemaVersion: typeof DESIRED_CONFIG_SCHEMA_VERSION;
  upstreams: UpstreamDefinition[];
  customNodes: ProxyNode[];
  policy: MaterializedPolicy;
}

export interface MaterializedArtifact {
  schemaVersion: 1;
  generatedAt: string;
  yaml: string;
}

export interface DesiredConfigV2 extends DesiredConfigDraft {
  revision: string;
  updatedAt: string;
  materializedArtifact?: MaterializedArtifact;
}

export const DEFAULT_MATERIALIZED_POLICY: MaterializedPolicy = {
  filterUpstreamInfoNodes: true,
  // A subscription hub should keep serving the last-known-good node set when
  // one commercial/free provider is temporarily unavailable. Operators can
  // opt into strict fail-closed behavior in x-clash-sub-hub.policy.
  missingCache: 'serve-stale',
  maxCacheAgeSeconds: 6 * 60 * 60,
};

export function createDesiredConfig(
  draft: DesiredConfigDraft,
  revision: string,
  updatedAt: string,
  materializedArtifact?: MaterializedArtifact
): DesiredConfigV2 {
  return {
    ...draft,
    revision,
    updatedAt,
    ...(materializedArtifact ? { materializedArtifact } : {}),
  };
}
