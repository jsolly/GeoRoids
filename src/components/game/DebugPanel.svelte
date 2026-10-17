<script lang="ts">
  import BugIcon from '@lucide/svelte/icons/bug';
  import type { DebugView } from '../../runtime/debugPresentation';
  import Button from '../ui/button/button.svelte';
  import Input from '../ui/input/input.svelte';
  import CopyControl from './CopyControl.svelte';

  let {
    view,
    inPlay,
    ontoggle,
    diagnostics,
    onreport = () => {},
  }: {
    view: DebugView;
    inPlay: boolean;
    ontoggle: () => void;
    diagnostics: () => string;
    onreport?: () => void;
  } = $props();
  let player = $state<HTMLInputElement | null>(null);
  let session = $state<HTMLInputElement | null>(null);
  function select(event: Event) {
    if (event.currentTarget instanceof HTMLInputElement) {
      event.currentTarget.select();
    }
  }
  const rows = [
    ['fps', 'FPS'],
    ['rtt', 'RTT'],
    ['snapshot', 'SNAP'],
    ['motion', 'MOVE'],
    ['world', 'WORLD'],
    ['releases', 'REL'],
  ] as const;
  const ids = {
    fps: 'fps',
    rtt: 'rtt',
    snapshot: 'snap',
    motion: 'move',
    world: 'world',
    releases: 'rel',
  };
</script>

{#if inPlay}
  <aside id="debug-play-stack" aria-label="Game diagnostics" class="debug-tools">
    <Button
      id="debug-hud-toggle"
      variant="outline"
      size="icon"
      class="debug-toggle min-h-11 min-w-11 rounded-full bg-card/95"
      aria-label={view.hudHidden ? 'Show diagnostics' : 'Hide diagnostics'}
      title={view.hudHidden ? 'Show diagnostics' : 'Hide diagnostics'}
      aria-controls="debug-hud"
      aria-expanded={!view.hudHidden}
      onclick={ontoggle}><BugIcon aria-hidden="true" class="size-5" /></Button
    >
    <section
      id="debug-hud"
      hidden={view.hudHidden}
      aria-label="Diagnostic details"
      class="debug-panel rounded-lg border border-border bg-card/95 p-3 text-xs text-foreground"
    >
      <dl class="mb-2 grid gap-1 break-all">
        <div>
          <dt class="text-muted-foreground">Player</dt>
          <dd id="debug-hud-player-id">{view.playerId || 'Not joined'}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">Page</dt>
          <dd id="debug-hud-session-id">{view.sessionId}</dd>
        </div>
        {#each rows as [key, label] (key)}
          <div class="flex justify-between gap-3">
            <dt class="text-muted-foreground">{label}</dt>
            <dd id={`debug-hud-${ids[key]}`}>{view[key]}</dd>
          </div>
        {/each}
      </dl>
      <Button variant="outline" class="mt-2 min-h-11 w-full" onclick={onreport}
        >Report a problem</Button
      >
      <div class="mt-3">
        <CopyControl
          id="copy-debug-diagnostics"
          name="diagnostics"
          label="Copy diagnostics"
          value={diagnostics}
        />
      </div>
    </section>
  </aside>
{:else}
  <section
    id="debug-identity"
    aria-label="Diagnostic identity"
    class="mt-5 grid gap-4 rounded-lg border border-border bg-background/50 p-4"
  >
    <Button variant="outline" class="min-h-11" onclick={onreport}>Report a problem</Button>
    <div class="grid gap-2">
      <label for="debug-player-id" class="text-sm">Player ID</label>
      <div class="flex gap-2">
        <Input
          id="debug-player-id"
          bind:ref={player}
          value={view.playerId}
          readonly
          spellcheck={false}
          autocomplete="off"
          placeholder="Available after Enter Game"
          aria-describedby="debug-player-id-hint"
          onfocus={select}
          onclick={select}
        />
        <CopyControl
          id="copy-debug-player-id"
          name="player ID"
          value={view.playerId}
          input={player ?? undefined}
        />
      </div>
      <p id="debug-player-id-hint" class="text-xs text-muted-foreground">Gameplay log ID</p>
    </div>
    <div class="grid gap-2">
      <label for="debug-session-id" class="text-sm">Page session</label>
      <div class="flex gap-2">
        <Input
          id="debug-session-id"
          bind:ref={session}
          value={view.sessionId}
          readonly
          spellcheck={false}
          autocomplete="off"
          aria-describedby="debug-session-id-hint"
          onfocus={select}
          onclick={select}
        />
        <CopyControl
          id="copy-debug-session-id"
          name="page session"
          value={view.sessionId}
          input={session ?? undefined}
        />
      </div>
      <p id="debug-session-id-hint" class="text-xs text-muted-foreground">Client log session</p>
    </div>
  </section>
{/if}

<style>
  .debug-tools {
    position: fixed;
    z-index: 30;
    top: max(12px, env(safe-area-inset-top));
    right: max(12px, env(safe-area-inset-right));
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    font-family: var(--font-sans);
    pointer-events: none;
  }
  .debug-tools :global(.debug-toggle),
  .debug-panel {
    pointer-events: auto;
  }
  .debug-panel {
    width: min(19rem, calc(100vw - 24px));
    max-height: 45dvh;
    overflow: auto;
  }
  .debug-panel[hidden] {
    display: none;
  }
  :global(body.touch-play) .debug-tools {
    top: calc(var(--mobile-controls-top, 80px) + 56px);
    left: max(12px, env(safe-area-inset-left));
    right: auto;
    align-items: flex-start;
  }
  :global(body.touch-play) .debug-panel {
    max-height: min(45dvh, var(--mobile-diagnostic-max-height, 45dvh));
  }
</style>
