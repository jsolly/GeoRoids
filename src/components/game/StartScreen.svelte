<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ShipKitId } from '../../../shared-types';
  import type { GameMenuView, GamePreference } from '../../runtime/uiTypes';
  import Button from '../ui/button/button.svelte';
  import Input from '../ui/input/input.svelte';
  import Preferences from './Preferences.svelte';
  import ShipPicker from './ShipPicker.svelte';

  let {
    view,
    playerName = $bindable(''),
    ready,
    joining,
    initializationError,
    joinError,
    onjoin,
    onretry,
    onselectship,
    onpreference,
    children,
  }: {
    view: GameMenuView;
    playerName: string;
    ready: boolean;
    joining: boolean;
    initializationError: string | null;
    joinError: string | null;
    onjoin: (name: string) => void;
    onretry: () => void;
    onselectship: (kit: ShipKitId) => void;
    onpreference: (kind: GamePreference, enabled: boolean) => void;
    children?: Snippet;
  } = $props();

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (ready && !joining) {
      onjoin(playerName);
    }
  }
</script>

<section class="start-screen dark" aria-labelledby="game-title">
  <div class="menu-card">
    <header class="mb-7">
      <p class="mb-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">
        A shared frontier
      </p>
      <h1 id="game-title" class="text-4xl font-semibold tracking-tight sm:text-5xl">GeoRoids</h1>
      <p class="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
        Survey the unknown. Tow together. Build something worth returning to.
      </p>
    </header>

    <form onsubmit={submit} class="grid gap-5" aria-busy={joining}>
      <div class="grid gap-2">
        <label for="playerNameInput" class="text-sm font-medium">Pilot name</label>
        <Input
          id="playerNameInput"
          name="pilotName"
          type="text"
          bind:value={playerName}
          maxlength={20}
          autocomplete="nickname"
          placeholder={view.fallbackName}
          disabled={joining}
          aria-describedby={joinError ? 'join-error' : undefined}
          class="h-12 bg-background/60"
        />
      </div>

      <ShipPicker selectedKit={view.selectedKit} disabled={joining} {onselectship} />
      <Preferences preferences={view.preferences} disabled={joining} {onpreference} />

      {#if initializationError}
        <div
          role="alert"
          class="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm"
        >
          <p>{initializationError}</p>
          <Button onclick={onretry} variant="outline" class="mt-3">Retry</Button>
        </div>
      {/if}
      {#if joinError}
        <p id="join-error" role="alert" class="text-sm text-destructive">{joinError}</p>
      {/if}

      <Button
        id="start-game"
        type="submit"
        disabled={!ready || joining}
        class="h-12 w-full text-base"
      >
        {joining ? 'Joining…' : ready ? 'Enter Game' : 'Preparing game…'}
      </Button>
    </form>

    {@render children?.()}

    <footer
      class="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-4 text-xs text-muted-foreground"
    >
      <a
        href="/wiki/"
        class="inline-flex min-h-11 items-center underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
        >Field manual <span aria-hidden="true" class="ml-2">↗</span></a
      >
      <span class="max-w-full break-words" aria-label="Game version">{view.buildInfo}</span>
    </footer>
  </div>
</section>

<style>
  .start-screen {
    position: fixed;
    z-index: 100;
    inset: 0;
    overflow-y: auto;
    display: grid;
    place-items: center;
    padding: max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom));
    background: rgb(10 10 10 / 86%);
    color: var(--foreground);
    font-family: var(--font-sans);
  }
  .menu-card {
    width: 100%;
    max-width: 700px;
    padding: clamp(24px, 5vw, 44px);
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--card);
    box-shadow: 0 24px 80px rgb(0 0 0 / 35%);
  }
  @media (max-width: 440px) {
    .start-screen {
      padding-inline: 12px;
    }
    .menu-card {
      padding: 24px 20px;
    }
  }
</style>
