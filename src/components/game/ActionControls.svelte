<script lang="ts">
  import { untrack } from 'svelte';
  import type { ActionControlsView, TouchActionElements } from '../../input/touchControls';
  import Button from '../ui/button/button.svelte';

  let {
    view,
    mountActions,
  }: {
    view: ActionControlsView;
    mountActions: (elements: TouchActionElements) => () => void;
  } = $props();
  let ability = $state<HTMLButtonElement | null>(null);
  let contourLock = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    const elements = ability && contourLock ? { ability, contourLock } : null;
    const mount = mountActions;
    if (elements) {
      return untrack(() => mount(elements));
    }
    return undefined;
  });
</script>

<div
  id="touch-controls"
  class={['touch-controls', view.touchMode ? 'is-touch' : 'is-desktop']}
  hidden={!view.inPlay}
  aria-hidden={!view.inPlay}
>
  <Button
    bind:ref={ability}
    id="touch-ability"
    variant="outline"
    hidden={!view.touchMode}
    class={[
      'touch-ability',
      {
        'is-ready': view.ability.ready,
        'is-pressed': view.ability.pressed,
        'is-active': view.ability.active,
        'is-cooling': view.ability.cooling && !view.ability.active,
        'is-unavailable': view.ability.unavailable,
      },
    ]}
    aria-label={view.ability.name}
    aria-disabled={view.ability.disabled}
    title={view.ability.name}
    style={`--action-cool: ${view.ability.cooldownRatio}`}>{view.ability.label}</Button
  >
  <Button
    bind:ref={contourLock}
    id="touch-contour-lock"
    variant="outline"
    class={[
      'touch-contour-lock',
      {
        'is-pressed': view.contourLock.pressed,
        'is-active': view.contourLock.active,
        'is-unavailable': view.contourLock.disabled,
      },
    ]}
    aria-label={view.contourLock.name}
    aria-pressed={view.contourLock.active}
    aria-disabled={view.contourLock.disabled}
    disabled={view.contourLock.disabled}
    title={view.contourLock.name}>{view.contourLock.label}</Button
  >
</div>

<style>
  .touch-controls {
    position: absolute;
    inset: 0;
    z-index: 20;
    pointer-events: none;
  }
  .touch-controls[hidden],
  .touch-controls :global([hidden]) {
    display: none;
  }
  .touch-controls :global(.touch-ability),
  .touch-controls :global(.touch-contour-lock) {
    --action-cool: 0;
    pointer-events: auto;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    -webkit-user-drag: none;
    -webkit-tap-highlight-color: transparent;
    position: absolute;
    box-sizing: border-box;
    bottom: calc(max(20px, env(safe-area-inset-bottom, 0px)) + 8px);
    width: 56px;
    height: 56px;
    border-radius: 50%;
    padding: 0;
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: 0.56rem;
    text-shadow: none;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--foreground);
    background: color-mix(in srgb, var(--card) 95%, transparent);
    border: 1px solid var(--border);
    box-shadow: 0 2px 6px rgb(0 0 0 / 20%);
  }
  .touch-controls :global(.touch-ability) {
    right: max(16px, env(safe-area-inset-right, 0px));
    z-index: 2;
  }
  .touch-controls :global(.touch-contour-lock) {
    left: 50%;
    transform: translateX(-50%);
    width: 152px;
    border-radius: 9px;
    overflow: hidden;
    isolation: isolate;
    font-size: 0.62rem;
    z-index: 1;
  }
  .touch-controls :global(.touch-contour-lock.is-active) {
    border-color: var(--primary);
    color: var(--primary-foreground);
    background: var(--primary);
  }
  .touch-controls :global(.touch-contour-lock:disabled) {
    cursor: not-allowed;
  }
  .touch-controls :global(.is-pressed),
  .touch-controls :global(.is-active) {
    background: var(--accent);
    color: var(--accent-foreground);
  }
  .touch-controls :global(.touch-ability.is-cooling) {
    opacity: 0.58;
    background: conic-gradient(
      color-mix(in srgb, currentColor 45%, transparent) calc(var(--action-cool) * 360deg),
      var(--card) 0
    );
  }
  .touch-controls :global(.is-unavailable) {
    opacity: 0.42;
  }
  .touch-controls :global(button:focus-visible) {
    outline: 2px solid var(--ring);
    outline-offset: 3px;
  }
  @media (orientation: landscape) and (max-height: 500px) {
    .touch-controls :global(.touch-ability),
    .touch-controls :global(.touch-contour-lock) {
      width: 140px;
      height: 48px;
      bottom: calc(max(12px, env(safe-area-inset-bottom, 0px)) + 8px);
      font-size: 0.5rem;
    }
    .touch-controls :global(.touch-ability) {
      width: 48px;
      right: max(20px, env(safe-area-inset-right, 0px));
    }
  }
  .is-touch :global(.touch-ability) {
    height: 44px;
    min-width: 0;
    padding: 0 3px;
    font-size: 10px;
    letter-spacing: 0.02em;
    border-radius: 6px;
    top: var(--mobile-controls-top);
    bottom: auto;
    right: auto;
    width: var(--action-width);
    left: calc(var(--action-left) + (var(--action-width) + 6px) * 3);
  }
</style>
