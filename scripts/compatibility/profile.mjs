import { readFile } from 'node:fs/promises';

export class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileError';
    this.code = 'INVALID_PROFILE';
  }
}

const requireValue = (condition, message) => { if (!condition) throw new ProfileError(message); };
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

/** Validate the experimental profile envelope; support claims require target-specific native evidence. */
export function validateProfile(profile) {
  requireValue(profile?.schemaVersion === 1, 'Expected compatibility profile schemaVersion 1.');
  requireValue(nonempty(profile.id) && Number.isSafeInteger(profile.revision) && profile.revision > 0, 'A profile needs an id and positive revision.');
  requireValue(['experimental', 'preview', 'stable'].includes(profile.maturity), 'Unknown profile maturity.');
  requireValue(profile.sourcePolicy?.applicationEdits === 'forbidden' && profile.sourcePolicy?.rendererMigration === 'forbidden', 'Profiles must preserve application source and renderer.');
  requireValue(Array.isArray(profile.targets) && profile.targets.length > 0 && Array.isArray(profile.features), 'Expected target and feature arrays.');
  const targets = new Set();
  for (const target of profile.targets) {
    requireValue(nonempty(target?.id) && !targets.has(target.id), 'Target ids must be nonempty and unique.');
    requireValue(['unverified', 'verified'].includes(target.status), `Unknown target status: ${target.id}`);
    if (target.status === 'verified') requireValue(nonempty(target.report), `Verified target needs an acceptance report: ${target.id}`);
    targets.add(target.id);
  }
  const features = new Set();
  for (const feature of profile.features) {
    requireValue(nonempty(feature?.id) && !features.has(feature.id), 'Feature ids must be nonempty and unique.');
    requireValue(['supported', 'unsupported', 'unknown'].includes(feature.status), `Unknown feature status: ${feature.id}`);
    requireValue(nonempty(feature.reason) && Array.isArray(feature.evidence), `Feature needs a reason and evidence array: ${feature.id}`);
    for (const evidence of feature.evidence) {
      requireValue(['probe', 'browser-reference', 'native-integration'].includes(evidence?.kind) && nonempty(evidence.path), `Invalid evidence: ${feature.id}`);
      if (evidence.kind === 'native-integration') {
        requireValue(targets.has(evidence.target) && nonempty(evidence.runtime) && nonempty(evidence.versions) && nonempty(evidence.constraints) && /^\d{4}-\d{2}-\d{2}$/.test(evidence.date ?? ''), `Native evidence must name target, runtime, versions, constraints and date: ${feature.id}`);
      }
    }
    if (feature.status === 'supported') requireValue(feature.evidence.some((item) => item.kind === 'native-integration'), `Probe or browser evidence cannot certify native support: ${feature.id}`);
    features.add(feature.id);
  }
  return profile;
}

export async function readProfile(path) {
  return validateProfile(JSON.parse(await readFile(path, 'utf8')));
}

/** Resolve a requirement without silently granting support to omitted APIs or untested targets. */
export function featureStatus(profile, featureId, targetId) {
  validateProfile(profile);
  if (!profile.targets.some((target) => target.id === targetId)) return { status: 'unknown', reason: `Target is absent from profile: ${targetId}` };
  const feature = profile.features.find((item) => item.id === featureId);
  if (!feature) return { status: 'unknown', reason: `Feature is absent from profile: ${featureId}` };
  if (feature.status === 'supported' && !feature.evidence.some((item) => item.kind === 'native-integration' && item.target === targetId)) return { status: 'unknown', reason: `No native integration evidence for ${featureId} on ${targetId}` };
  return { status: feature.status, reason: feature.reason };
}
