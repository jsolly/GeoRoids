import assert from 'node:assert/strict';

/** Single unmasked uncompressed FIN text frame. Wire-ledger checks native TCP totals. */
export function websocketTextHeaderBytes(payloadBytes: number): 2 | 4 | 10 {
  assert(
    Number.isSafeInteger(payloadBytes) && payloadBytes >= 0,
    'Invalid WebSocket payload bytes'
  );
  return payloadBytes <= 125 ? 2 : payloadBytes <= 65_535 ? 4 : 10;
}
