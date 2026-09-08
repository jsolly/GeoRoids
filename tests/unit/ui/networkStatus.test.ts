import { beforeEach, expect, test } from 'vitest';
import {
  DISCONNECT_BANNER_TEXT,
  hideNetworkBanner,
  initNetworkStatusUI,
  isNetworkBannerVisible,
  RECONNECTING_BANNER_TEXT,
  showNetworkBanner,
} from '../../../src/ui/networkStatus';

beforeEach(() => {
  hideNetworkBanner();
});

test('banner is hidden by default', () => {
  expect(isNetworkBannerVisible()).toBe(false);
});

test('showNetworkBanner reveals it and hideNetworkBanner hides it', () => {
  showNetworkBanner('Disconnected');
  expect(isNetworkBannerVisible()).toBe(true);
  hideNetworkBanner();
  expect(isNetworkBannerVisible()).toBe(false);
});

test('a networkDisconnected event shows the banner; (re)connect hides it', () => {
  initNetworkStatusUI();

  window.dispatchEvent(new CustomEvent('networkDisconnected', { detail: { reason: 'test' } }));
  expect(isNetworkBannerVisible()).toBe(true);

  window.dispatchEvent(new CustomEvent('networkConnected'));
  expect(isNetworkBannerVisible()).toBe(false);

  window.dispatchEvent(new CustomEvent('networkDisconnected', { detail: {} }));
  expect(isNetworkBannerVisible()).toBe(true);

  window.dispatchEvent(new CustomEvent('networkReconnected'));
  expect(isNetworkBannerVisible()).toBe(false);
});

test('a reconnecting event shows a temporary banner that hides on reconnect', () => {
  initNetworkStatusUI();

  window.dispatchEvent(new CustomEvent('networkReconnecting'));
  expect(isNetworkBannerVisible()).toBe(true);
  expect(document.getElementById('network-status-banner')?.textContent).toBe(
    RECONNECTING_BANNER_TEXT
  );

  window.dispatchEvent(new CustomEvent('networkReconnected'));
  expect(isNetworkBannerVisible()).toBe(false);

  window.dispatchEvent(new CustomEvent('networkPermanentlyDisconnected', { detail: {} }));
  expect(isNetworkBannerVisible()).toBe(true);
  expect(document.getElementById('network-status-banner')?.textContent).toBe(
    DISCONNECT_BANNER_TEXT
  );
});
