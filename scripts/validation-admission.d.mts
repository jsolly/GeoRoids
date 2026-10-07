export function runAdmitted(
  kind: 'checkout' | 'review' | 'runner' | 'frame' | 'contracts' | 'unit' | 'integration',
  command: readonly string[],
  options?: { root?: string; environment?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<number>;
export function verifyChild(
  root: string,
  kind: 'checkout' | 'review' | 'runner' | 'frame' | 'contracts' | 'unit' | 'integration',
  pid?: number
): void;
