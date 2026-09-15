import { releaseField } from '../../../shared/releaseId';
import { getClientReleaseId } from '../../utils/buildInfo';
import { sanitizePlayerName } from '../../utils/playerName';
import { getStoredItem, removeStoredItem, setStoredItem } from '../../utils/safeStorage';

const RESUME_TOKEN_STORAGE_KEY = 'georoids-resume-token';
const RESUME_NAME_STORAGE_KEY = 'georoids-resume-name';
const RESUME_PROVENANCE_STORAGE_KEY = 'georoids-resume-provenance';

type ResumeReleaseProvenance = {
  credentialReleaseId?: string;
  scoreReleaseId?: string;
  clientReleaseId?: string;
};

export function isValidResumeToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

export function readStoredResumeToken(): string | undefined {
  const token = getStoredItem(RESUME_TOKEN_STORAGE_KEY);
  return isValidResumeToken(token) ? token : undefined;
}

export function readStoredResumeName(): string | undefined {
  const name = sanitizePlayerName(getStoredItem(RESUME_NAME_STORAGE_KEY) ?? '');
  return name.length > 0 ? name : undefined;
}

export function readStoredResumeProvenance(): ResumeReleaseProvenance | undefined {
  const raw = getStoredItem(RESUME_PROVENANCE_STORAGE_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const provenance = {
      ...releaseField('credentialReleaseId', record['credentialReleaseId']),
      ...releaseField('scoreReleaseId', record['scoreReleaseId']),
      ...releaseField('clientReleaseId', record['clientReleaseId']),
    };
    return Object.keys(provenance).length > 0 ? provenance : undefined;
  } catch {
    return undefined;
  }
}

export function storeResumeCredential(
  token: string,
  name: string,
  provenance?: ResumeReleaseProvenance
): void {
  if (!isValidResumeToken(token)) {
    return;
  }
  setStoredItem(RESUME_TOKEN_STORAGE_KEY, token);
  const sanitized = sanitizePlayerName(name);
  if (sanitized) {
    setStoredItem(RESUME_NAME_STORAGE_KEY, sanitized);
  } else {
    removeStoredItem(RESUME_NAME_STORAGE_KEY);
  }
  const stored = {
    ...releaseField('credentialReleaseId', provenance?.credentialReleaseId),
    ...releaseField('scoreReleaseId', provenance?.scoreReleaseId),
    ...releaseField('clientReleaseId', provenance?.clientReleaseId ?? getClientReleaseId()),
  };
  if (Object.keys(stored).length > 0) {
    setStoredItem(RESUME_PROVENANCE_STORAGE_KEY, JSON.stringify(stored));
  } else {
    removeStoredItem(RESUME_PROVENANCE_STORAGE_KEY);
  }
}

export function clearResumeCredential(): void {
  removeStoredItem(RESUME_TOKEN_STORAGE_KEY);
  removeStoredItem(RESUME_NAME_STORAGE_KEY);
  removeStoredItem(RESUME_PROVENANCE_STORAGE_KEY);
}
