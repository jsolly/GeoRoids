<script lang="ts">
  import { untrack } from 'svelte';
  import { LOCAL_STORAGE_KEYS } from '../../constants/user-preferences';
  import type { ActionControlsView, TouchActionElements } from '../../input/touchControls';
  import { activateObjectMenuAction, dismissObjectMenu } from '../../input/touchControls';
  import { getStoredItem, setStoredItem } from '../../utils/safeStorage';
  import Button from '../ui/button/button.svelte';

  let {
    view,
    mountActions,
  }: {
    view: ActionControlsView;
    mountActions: (elements: TouchActionElements) => () => void;
  } = $props();
  let showHelp = $state(getStoredItem(LOCAL_STORAGE_KEYS.mobileFlightHelpDismissed) !== 'true');
  let ability = $state<HTMLButtonElement | null>(null);
  let contourLock = $state<HTMLButtonElement | null>(null);

  let fire = $state<HTMLButtonElement | null>(null);
  let stop = $state<HTMLButtonElement | null>(null);
  let shield = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    const elements =
      ability && contourLock && fire && stop && shield
        ? { ability, contourLock, fire, stop, shield }
        : null;
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
  <Button
    bind:ref={fire}
    class="touch-fire"
    variant="outline"
    hidden={!view.touchMode}
    aria-label="Fire: tap for a shot, hold to charge, drag to aim">FIRE</Button
  >
  <Button bind:ref={stop} class="touch-stop" hidden={!view.touchMode} aria-label="Stop travelling"
    >STOP</Button
  >
  <Button
    bind:ref={shield}
    class="touch-shield"
    variant="outline"
    hidden={!view.touchMode}
    disabled={view.shield?.disabled}
    aria-label="Activate shield"
    style={`--shield-cool: ${view.shield?.ratio ?? 0}`}
  >
    {view.shield?.active ? 'SHIELDED' : 'SHIELD'}
    {view.shield?.seconds || ''}
  </Button>
  {#if view.touchMode && showHelp}
    <div class="flight-help" role="group" aria-label="Mobile flight controls">
      <p>
        Tap to travel. Hold an object for actions. Tap Fire to shoot; hold to charge, drag to aim.
        Two fingers activate Shield. Swipe or tap your tool indicator to use it.
      </p>
      <Button
        onclick={() => {
          showHelp = false;
          setStoredItem(LOCAL_STORAGE_KEYS.mobileFlightHelpDismissed, 'true');
        }}>Got it</Button
      >
    </div>
  {/if}
  {#if view.touchMode}
    <p class="travel-status" aria-live="polite">
      {view.navigation?.status || (view.holding ? 'Hold for actions…' : '')}
    </p>
  {/if}
  {#if view.menu}
    <div
      class="object-menu"
      role="group"
      aria-label={`${view.menu.target.name} actions`}
      style={`left: clamp(8px, ${view.menu.x + 20}px, calc(100% - 208px)); top: clamp(8px, ${view.menu.y - 80}px, calc(100% - 320px))`}
    >
      <span>{view.menu.target.name}</span>
      {#each view.menu.actions as item}
        <Button
          data-object-action={item.action}
          disabled={item.disabled}
          onclick={() => activateObjectMenuAction(item.action)}>{item.label}</Button
        >
      {/each}
      <Button onclick={dismissObjectMenu}>Cancel</Button>
    </div>
  {/if}
</div>

<style>
  .touch-controls :global(.touch-fire),
  .touch-controls :global(.touch-stop),
  .touch-controls :global(.touch-shield) {
    position: absolute;
    pointer-events: auto;
    touch-action: none;
    min-width: 56px;
    min-height: 48px;
    bottom: max(20px, env(safe-area-inset-bottom, 0px));
  }
  .touch-controls :global(.touch-fire) {
    right: 16px;
    width: 72px;
    height: 72px;
    border-radius: 50%;
  }
  .touch-controls :global(.touch-stop) {
    left: 16px;
  }
  .touch-controls :global(.touch-shield) {
    left: 16px;
    bottom: max(108px, calc(env(safe-area-inset-bottom, 0px) + 108px));
    background: conic-gradient(var(--accent) calc(var(--shield-cool) * 360deg), var(--card) 0);
  }
  .flight-help {
    position: absolute;
    top: 20%;
    left: 10%;
    width: 80%;
    padding: 12px;
    border-radius: 8px;
    background: var(--card);
    color: var(--foreground);
    pointer-events: auto;
    font-size: 13px;
  }
  .travel-status {
    position: absolute;
    bottom: 170px;
    left: 16px;
    max-width: 65%;
    font-size: 12px;
    color: var(--foreground);
  }
  .object-menu {
    position: absolute;
    width: 200px;
    display: grid;
    gap: 4px;
    padding: 8px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    pointer-events: auto;
  }
  .object-menu :global(button) {
    min-height: 44px;
  }
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
