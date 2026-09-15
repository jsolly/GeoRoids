import { sanitizePlayerName } from '../../utils/playerName';
import { getStoredItem, removeStoredItem, setStoredItem } from '../../utils/safeStorage';

const RESUME_TOKEN_STORAGE_KEY = 'georoids-resume-token';
const RESUME_NAME_STORAGE_KEY = 'georoids-resume-name';

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

export function storeResumeCredential(token: string, name: string): void {
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
}

export function clearResumeCredential(): void {
  removeStoredItem(RESUME_TOKEN_STORAGE_KEY);
  removeStoredItem(RESUME_NAME_STORAGE_KEY);
}
