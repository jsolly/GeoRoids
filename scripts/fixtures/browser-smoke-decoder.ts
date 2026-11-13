/** A strict live-mode constructor fixture. Production codec behavior is tested separately. */
export class SnapshotDecoder {
  private resetBeforeRead = false;

  constructor(mode: 'live') {
    if (mode !== 'live') {
      throw new Error('Expected live construction');
    }
  }

  reset(): void {
    this.resetBeforeRead = true;
  }

  readMessage(text: string, admission: { readonly acceptSnapshots: boolean }): unknown {
    if (!this.resetBeforeRead || typeof admission.acceptSnapshots !== 'boolean') {
      throw new Error('Expected reset and explicit admission');
    }
    const result: unknown = JSON.parse(text);
    return result;
  }
}
