import { DesiredConfigDraft, MaterializedArtifact } from './config';
import { MergeDiff, diffDesiredConfig, parseMergeYaml } from './merge';
import {
  ConfigConflictError,
  TextKv,
  loadActiveDesiredConfig,
  publishDesiredConfig,
  toDraft,
} from '../storage/config-state';

export interface MergeImportPreview {
  baseRevision: string;
  diff: MergeDiff;
  counts: {
    upstreams: number;
    customNodes: number;
  };
}

export interface MergeImportApplyResult extends MergeImportPreview {
  revision: string;
  changed: boolean;
}

export async function previewMergeImport(
  kv: TextKv,
  yamlText: string
): Promise<MergeImportPreview> {
  const current = await loadActiveDesiredConfig(kv);
  const currentDraft = toDraft(current);
  const desired = parseMergeYaml(yamlText, currentDraft);
  return makePreview(current.revision, currentDraft, desired);
}

export async function applyMergeImport(
  kv: TextKv,
  yamlText: string,
  options: {
    strategy: string;
    baseRevision: string;
    now?: () => Date;
    revisionFactory?: () => string;
    prepare?: (
      desired: DesiredConfigDraft
    ) => Promise<MaterializedArtifact | void>;
  }
): Promise<MergeImportApplyResult> {
  if (options.strategy !== 'replace') {
    throw new Error('仅支持 strategy: replace');
  }

  const current = await loadActiveDesiredConfig(kv);
  if (current.revision !== options.baseRevision) {
    throw new ConfigConflictError(current.revision);
  }

  const currentDraft = toDraft(current);
  const desired = parseMergeYaml(yamlText, currentDraft);
  const preview = makePreview(current.revision, currentDraft, desired);
  const materializedArtifact = preview.diff.hasChanges && options.prepare
    ? await options.prepare(desired)
    : undefined;
  const published = await publishDesiredConfig(kv, desired, {
    expectedRevision: options.baseRevision,
    now: options.now,
    revisionFactory: options.revisionFactory,
    materializedArtifact: materializedArtifact || undefined,
  });

  return {
    ...preview,
    revision: published.config.revision,
    changed: published.changed,
  };
}

function makePreview(
  baseRevision: string,
  current: DesiredConfigDraft,
  desired: DesiredConfigDraft
): MergeImportPreview {
  return {
    baseRevision,
    diff: diffDesiredConfig(current, desired),
    counts: {
      upstreams: desired.upstreams.length,
      customNodes: desired.customNodes.length,
    },
  };
}
