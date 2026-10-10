<script lang="ts">
  import { tick } from 'svelte';
  import type { TownStoreView, TownView } from '../../runtime/townStore';
  import type { FurnaceTravelView } from '../../ui/furnaceTravelMap';
  import Button from '../ui/button/button.svelte';
  import FurnaceTravelMap from './FurnaceTravelMap.svelte';

  let {
    view,
    onmode,
    onpurchase,
    onclose,
    travel,
    ontravel,
  }: {
    view: TownStoreView;
    onmode: (mode: TownView) => void;
    onpurchase: (id: string) => void;
    onclose: () => void;
    travel: FurnaceTravelView | null;
    ontravel: (id: string) => void;
  } = $props();

  let returnButton = $state<HTMLButtonElement | null>(null);

  $effect.pre(() => {
    const offers = view.offers;
    const mode = view.mode;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) {
      return;
    }
    const id = focused.dataset['townOffer'];
    if (id && (mode !== 'store' || !offers.find((offer) => offer.id === id)?.available)) {
      void tick().then(() => {
        if (document.activeElement === focused || document.activeElement === document.body) {
          returnButton?.focus({ preventScroll: true });
        }
      });
    }
  });
</script>

<div class="town-panel grid gap-5">
  <div class="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
    <p>{view.sourceName}</p>
    <p>Bank {view.bank.toLocaleString()} · Settlement level {view.level}</p>
  </div>

  {#if view.mode === 'entry'}
    <div class="grid gap-3 sm:grid-cols-2">
      <Button variant="outline" class="min-h-14" onclick={() => onmode('store')}>Store</Button>
      <Button variant="outline" class="min-h-14" onclick={() => onmode('travel')}
        >Fast Travel</Button
      >
    </div>
  {:else if view.mode === 'store'}
    <p class="text-sm leading-relaxed text-muted-foreground">
      Store purchases have no gameplay effect.
    </p>
    <ul class="grid gap-3">
      {#each view.offers as offer (offer.id)}
        <li
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
        >
          <div class="min-w-0">
            <p class="text-sm font-medium">{offer.name}</p>
            <p id={`town-price-${offer.id}`} class="text-xs leading-relaxed text-muted-foreground">
              {offer.cost.toLocaleString()} banked points · Level {offer.level}
            </p>
          </div>
          <Button
            variant="outline"
            class="min-h-11 whitespace-normal"
            data-town-offer={offer.id}
            aria-describedby={`town-price-${offer.id}`}
            disabled={!offer.available || offer.owned || offer.locked}
            onclick={() => onpurchase(offer.id)}
            >{offer.owned
              ? 'Purchased'
              : offer.locked
                ? `Unlocks at level ${offer.level}`
                : `Buy ${offer.name}`}</Button
          >
        </li>
      {/each}
    </ul>
  {:else}
    <section aria-labelledby="town-travel-title" class="grid gap-3">
      <h3 id="town-travel-title" class="text-sm font-medium">Destination map</h3>
      <p class="text-sm leading-relaxed text-muted-foreground">
        Ride your ship along the pipes to any lit furnace. Travel is free.
      </p>
      {#if travel}
        {#key travel.source.id}
          <FurnaceTravelMap view={travel} {ontravel} />
        {/key}
      {/if}
    </section>
  {/if}

  {#if view.atTown && view.mode !== 'entry'}
    <Button variant="outline" class="min-h-11" onclick={() => onmode('entry')}
      >Back to Town Square</Button
    >
  {/if}
  <p role="status" aria-live="polite" aria-atomic="true" class="text-sm text-muted-foreground">
    {view.status}
  </p>
  <Button bind:ref={returnButton} class="min-h-11 w-full" onclick={onclose}>Return to flight</Button
  >
</div>

<style>
  .town-panel {
    font-family: var(--font-sans);
  }
</style>
