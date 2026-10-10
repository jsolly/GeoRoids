import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as feedback from '../../../src/audio/feedbackSounds';
import {
  DISCONNECT_BANNER_TEXT,
  hideNetworkBanner,
  mountNetworkStatus,
  RECONNECTING_BANNER_TEXT,
  readNetworkStatus,
  showNetworkBanner,
  subscribeNetworkStatus,
} from '../../../src/ui/networkStatus';

let dispose: (() => void) | undefined;
beforeEach(() => {
  hideNetworkBanner();
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  hideNetworkBanner();
  vi.restoreAllMocks();
});

test('a new network status is hidden until an explicit terminal message is shown', () => {
  expect(readNetworkStatus()).toBeNull();
  showNetworkBanner('Disconnected');
  expect(readNetworkStatus()).toEqual({ message: 'Disconnected', tone: 'error' });
  hideNetworkBanner();
  expect(readNetworkStatus()).toBeNull();
});

test('disconnect events publish the banner and either connection event clears it', () => {
  dispose = mountNetworkStatus();
  for (const reconnect of ['networkConnected', 'networkReconnected']) {
    window.dispatchEvent(new CustomEvent('networkDisconnected', { detail: { reason: 'test' } }));
    expect(readNetworkStatus()).toEqual({ message: DISCONNECT_BANNER_TEXT, tone: 'error' });
    window.dispatchEvent(new CustomEvent(reconnect));
    expect(readNetworkStatus()).toBeNull();
  }
});

test('retrying publishes a temporary tone and terminal failure announces loss once until recovery', () => {
  const sound = vi.spyOn(feedback, 'playFeedback').mockImplementation(() => {});
  dispose = mountNetworkStatus();
  window.dispatchEvent(new CustomEvent('networkReconnecting'));
  expect(readNetworkStatus()).toEqual({ message: RECONNECTING_BANNER_TEXT, tone: 'reconnect' });
  window.dispatchEvent(new CustomEvent('networkReconnected'));
  expect(readNetworkStatus()).toBeNull();
  window.dispatchEvent(new CustomEvent('networkPermanentlyDisconnected', { detail: {} }));
  window.dispatchEvent(new CustomEvent('networkPermanentlyDisconnected', { detail: {} }));
  expect(readNetworkStatus()).toEqual({ message: DISCONNECT_BANNER_TEXT, tone: 'error' });
  expect(sound).toHaveBeenCalledExactlyOnceWith('connectionLost');
  window.dispatchEvent(new Event('networkConnected'));
  window.dispatchEvent(new CustomEvent('networkPermanentlyDisconnected', { detail: {} }));
  expect(sound).toHaveBeenCalledTimes(2);
});

test('unchanged messages do not republish and disposing retires only the mounted lifecycle', () => {
  const changed = vi.fn();
  const unsubscribe = subscribeNetworkStatus(changed);
  dispose = mountNetworkStatus();
  const duplicate = mountNetworkStatus();
  duplicate();
  showNetworkBanner('Lost'.repeat(200));
  const snapshot = readNetworkStatus();
  expect(snapshot?.message).toHaveLength(500);
  expect(Object.isFrozen(snapshot)).toBe(true);
  showNetworkBanner('Lost'.repeat(200));
  expect(changed).toHaveBeenCalledTimes(1);
  dispose();
  expect(readNetworkStatus()).toBeNull();
  window.dispatchEvent(new Event('networkReconnecting'));
  expect(readNetworkStatus()).toBeNull();
  const previous = dispose;
  dispose = mountNetworkStatus();
  previous();
  window.dispatchEvent(new Event('networkReconnecting'));
  expect(readNetworkStatus()?.tone).toBe('reconnect');
  unsubscribe();
});
