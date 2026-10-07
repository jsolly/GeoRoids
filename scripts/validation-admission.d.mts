export function runAdmitted(
  kind: 'checkout' | 'review' | 'runner' | 'frame' | 'contracts',
  command: readonly string[],
  options?: { root?: string; environment?: NodeJS.ProcessEnv }
): Promise<number>;
export function verifyChild(
  root: string,
  kind: 'checkout' | 'review' | 'runner' | 'frame' | 'contracts',
  pid?: number
): void;
