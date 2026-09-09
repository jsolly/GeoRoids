import type { Page } from 'playwright';

export type BrowserDiagnostics = {
  readonly errors: string[];
  readonly warnings: string[];
};

/** Collect browser diagnostics that should fail a critical behavioral run. */
export function watchBrowserDiagnostics(page: Page): BrowserDiagnostics {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    } else if (message.type() === 'warning') {
      warnings.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return { errors, warnings };
}

export function assertNoBrowserDiagnostics(diagnostics: BrowserDiagnostics): void {
  if (diagnostics.errors.length > 0 || diagnostics.warnings.length > 0) {
    throw new Error(
      `Browser diagnostics reported errors=${JSON.stringify(diagnostics.errors)} ` +
        `warnings=${JSON.stringify(diagnostics.warnings)}`
    );
  }
}
