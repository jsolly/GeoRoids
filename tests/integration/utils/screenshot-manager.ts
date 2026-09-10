import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class ScreenshotManager {
  private readonly screenshotsDir: string;

  constructor(_testDir?: string) {
    // Use centralized screenshots directory under browser tests
    this.screenshotsDir = join(process.cwd(), 'tests', 'integration', 'browser', 'screenshots');
  }

  /**
   * Preserve timestamped evidence from every scenario in this run.
   */
  ensureScreenshotsDirectory(): void {
    mkdirSync(this.screenshotsDir, { recursive: true });
  }

  /**
   * Generate a timestamped filename
   */
  getTimestampedFilename(prefix: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${prefix}-${timestamp}.png`;
  }

  /**
   * Get the full path for a screenshot
   */
  getScreenshotPath(filename: string): string {
    return join(this.screenshotsDir, filename);
  }

  getScreenshotsDir(): string {
    return this.screenshotsDir;
  }
}
