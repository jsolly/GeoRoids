/**
 * Scroll offset for one field-manual history visit.
 * Back and Forward restore that visit. A new visit opens at the top.
 *
 * The offset is kept in memory and on the history entry. Memory wins for
 * this document, so a Back that happens before the scroll event still
 * returns to the offset on screen. The history entry covers reload and
 * returning from another page. History writes are paced so a long read
 * does not flood `replaceState`.
 */
export class WikiScrollMemory {
  private readonly positions = new Map<string, number>();
  private id: string;
  private restore = false;
  private restoreY = 0;
  private destinationId: string | undefined;
  private ignoreScroll = false;
  private pushed = false;
  private ticket = 0;
  private rememberTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingY = 0;
  private pendingRemember = false;

  constructor(
    id: string,
    private readonly writeY: (y: number) => void,
    private readonly remember: (id: string, y: number) => void,
    private readonly readY: () => number
  ) {
    this.id = id;
  }

  noteScroll(y: number): void {
    if (this.ignoreScroll || this.pushed || this.restore) {
      return;
    }
    this.positions.set(this.id, y);
    this.queueRemember(y);
  }

  /** Keeps the current offset while search results replace the entry. */
  hold(y: number): void {
    this.positions.set(this.id, y);
    this.pendingY = y;
    this.pendingRemember = true;
    this.flushRemember();
    this.ignoreScroll = true;
  }

  /** Shows the entry again after search and continues recording scroll. */
  release(): void {
    this.ignoreScroll = false;
    this.pushed = false;
    this.writeY(this.positions.get(this.id) ?? 0);
  }

  /**
   * The document is going away. Save the offset on screen, or the offset
   * already held, and ignore a scroll reset during the navigation.
   */
  capture(y: number): void {
    if (this.ignoreScroll || this.pushed || this.restore) {
      this.flushRemember();
      return;
    }
    if (y === 0 && this.pendingRemember && this.pendingY > 0) {
      this.flushRemember();
      return;
    }
    this.positions.set(this.id, y);
    this.pendingY = y;
    this.pendingRemember = true;
    this.flushRemember();
  }

  /**
   * A normal link is leaving this document. Keep the offset on screen and
   * ignore the scroll reset that follows the click.
   */
  prepareForDocumentLeave(y: number): void {
    this.capture(y);
    this.ignoreScroll = true;
  }

  /** A link click is about to change the entry. Ignore the browser's jump to the top. */
  prepareForLink(y: number): void {
    if (!this.ignoreScroll) {
      this.positions.set(this.id, y);
      this.pendingY = y;
      this.pendingRemember = true;
    }
    this.flushRemember();
    this.pushed = true;
    this.armIgnore();
  }

  /**
   * Back or Forward. `leavingY` is still the page on screen; the history
   * entry has already switched to the destination.
   * Hash clicks also emit popstate; those stay ordinary visits.
   */
  prepareForTraversal(
    destinationId: string | undefined,
    destinationY: number | undefined,
    leavingY: number
  ): void {
    if (this.pushed) {
      return;
    }
    if (!this.ignoreScroll) {
      this.positions.set(this.id, leavingY);
    }
    this.destinationId = destinationId;
    this.restoreY =
      (destinationId !== undefined ? this.positions.get(destinationId) : undefined) ??
      destinationY ??
      0;
    this.restore = true;
    this.armIgnore();
  }

  /** Puts a reloaded or restored document back at its saved offset. */
  restoreSaved(y: number): void {
    this.ignoreScroll = false;
    this.pushed = false;
    this.positions.set(this.id, y);
    this.writeY(y);
  }

  show(createId: () => string, fresh?: () => void): void {
    this.ticket += 1;
    this.pushed = false;
    this.cancelRemember();
    const restoring = this.restore;
    const y = this.restoreY;
    const destinationId = this.destinationId;
    this.restore = false;
    this.destinationId = undefined;
    this.ignoreScroll = true;
    if (restoring) {
      this.id = destinationId ?? createId();
      this.positions.set(this.id, y);
      this.writeY(y);
      this.remember(this.id, y);
      this.ignoreScroll = false;
      return;
    }
    this.id = createId();
    if (fresh) {
      fresh();
    } else {
      this.writeY(0);
    }
    const landed = this.readY();
    this.positions.set(this.id, landed);
    this.remember(this.id, landed);
    this.ignoreScroll = false;
  }

  private queueRemember(y: number): void {
    this.pendingY = y;
    this.pendingRemember = true;
    if (this.rememberTimer) {
      return;
    }
    this.rememberTimer = setTimeout(() => {
      this.rememberTimer = undefined;
      this.flushRemember();
    }, 500);
  }

  private flushRemember(): void {
    if (this.rememberTimer) {
      clearTimeout(this.rememberTimer);
      this.rememberTimer = undefined;
    }
    if (!this.pendingRemember) {
      return;
    }
    this.pendingRemember = false;
    this.remember(this.id, this.pendingY);
  }

  private cancelRemember(): void {
    if (this.rememberTimer) {
      clearTimeout(this.rememberTimer);
      this.rememberTimer = undefined;
    }
    this.pendingRemember = false;
  }

  private armIgnore(): void {
    this.ignoreScroll = true;
    const ticket = ++this.ticket;
    setTimeout(() => {
      if (this.ticket !== ticket) {
        return;
      }
      this.ignoreScroll = false;
      this.pushed = false;
    }, 0);
  }
}
