import { afterEach, beforeEach, expect, test } from 'vitest';
import { initializePlayfieldSelection } from '../../../src/input/playfieldSelection';
import { closeGameOverlay, openGameOverlay } from '../../../src/runtime/overlayState';
import { setPlayView } from '../../../src/ui/uiUtils';

beforeEach(() => {
  initializePlayfieldSelection();
  setPlayView(true);
});

afterEach(() => {
  closeGameOverlay('debug-report');
  document.getSelection()?.removeAllRanges();
  setPlayView(false);
  document.body.replaceChildren();
});

test('playfield selectstart is cancelled during flight', () => {
  const hud = document.createElement('div');
  hud.textContent = 'Lives 3';
  document.body.append(hud);
  const ev = new Event('selectstart', { bubbles: true, cancelable: true });
  hud.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
});

test('title-screen selectstart still works before flight', () => {
  setPlayView(false);
  const hint = document.createElement('p');
  hint.textContent = 'Always thrust';
  document.body.append(hint);
  const ev = new Event('selectstart', { bubbles: true, cancelable: true });
  hint.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(false);
});

test('nickname fields still start selection during flight', () => {
  const input = document.createElement('input');
  input.value = 'Pilot';
  document.body.append(input);
  const ev = new Event('selectstart', { bubbles: true, cancelable: true });
  input.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(false);
});

test('playfield context menu is cancelled during flight', () => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  canvas.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);
});

test('a stray playfield selection collapses during flight', () => {
  const hud = document.createElement('span');
  hud.textContent = 'Score 12';
  document.body.append(hud);
  const range = document.createRange();
  range.selectNodeContents(hud);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  expect(selection?.rangeCount).toBe(1);
  document.dispatchEvent(new Event('selectionchange'));
  expect(selection?.rangeCount).toBe(0);
});

test('an editable field keeps its selection if a selectionchange fires during flight', () => {
  const field = document.createElement('div');
  field.setAttribute('contenteditable', 'true');
  field.textContent = 'Pilot';
  document.body.append(field);
  const range = document.createRange();
  range.selectNodeContents(field);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  expect(selection?.rangeCount).toBe(1);
});

test('a report textarea owns native selection while the flight remains active behind its modal', () => {
  const text = document.createElement('p');
  text.textContent = 'Report a problem';
  const field = document.createElement('textarea');
  field.value = 'Typing on my tablet';
  document.body.append(text, field);
  const range = document.createRange();
  range.selectNodeContents(text);
  const selection = document.getSelection();
  openGameOverlay('debug-report');
  field.focus();
  field.setSelectionRange(0, 6);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  expect(document.activeElement).toBe(field);
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, 6]);
  expect(selection?.rangeCount).toBe(1);
  const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  text.dispatchEvent(context);
  expect(context.defaultPrevented).toBe(false);
  const select = new Event('selectstart', { bubbles: true, cancelable: true });
  text.dispatchEvent(select);
  expect(select.defaultPrevented).toBe(false);
  closeGameOverlay('debug-report');
  document.dispatchEvent(new Event('selectionchange'));
  expect(selection?.rangeCount).toBe(0);
});
