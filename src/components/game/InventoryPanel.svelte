<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { HaulerUtilityId, ScoutUtilityId } from '../../../shared-types';
  import type { InventoryView } from '../../runtime/uiTypes';
  import Button from '../ui/button/button.svelte';

  let {
    view,
    onpage,
    onequip,
    onutility,
    onclose,
    draw,
  }: {
    view: InventoryView;
    onpage: (page: number) => void;
    onequip: (pickupId: string) => void;
    onutility: (utilityId: HaulerUtilityId | ScoutUtilityId) => void;
    onclose: () => void;
    draw: (
      hull: HTMLCanvasElement,
      tool: HTMLCanvasElement
    ) => { refresh(): void; dispose(): void };
  } = $props();

  let hull: HTMLCanvasElement;
  let tool: HTMLCanvasElement;
  let returnButton = $state<HTMLButtonElement | null>(null);
  let items = $derived(view.items.slice(0, 24));
  let selectedTool = $derived(view.tools.find((option) => option.selected));

  let painter: ReturnType<typeof draw> | undefined;
  let paintedKit: string;
  let paintedTool: HaulerUtilityId | ScoutUtilityId | undefined;

  onMount(() => {
    painter = draw(hull, tool);
    paintedKit = view.kitName;
    paintedTool = selectedTool?.id;
    painter.refresh();
    return () => {
      painter?.dispose();
      painter = undefined;
    };
  });

  $effect(() => {
    const kit = view.kitName;
    const utility = selectedTool?.id;
    if (painter && (kit !== paintedKit || utility !== paintedTool)) {
      paintedKit = kit;
      paintedTool = utility;
      painter.refresh();
    }
  });

  $effect.pre(() => {
    const nextItems = items;
    const canEquip = view.canEquipSatellite;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) {
      return;
    }
    const pickupId = focused.dataset['inventoryEquip'];
    if (!pickupId) {
      return;
    }
    const item = nextItems.find((pickup) => pickup.id === pickupId);
    if (!item || item.equipped || !canEquip) {
      void tick().then(() => {
        if (document.activeElement === focused || document.activeElement === document.body) {
          returnButton?.focus({ preventScroll: true });
        }
      });
    }
  });
</script>

<div class="inventory-panel grid gap-6">
  <section aria-label="Ship and tool" class="grid grid-cols-2 gap-3">
    <div class="rounded-xl border border-border bg-background/50 p-3">
      <h3 class="text-sm font-medium">{view.kitName}</h3>
      <canvas bind:this={hull} aria-label={`${view.kitName} hull schematic`} class="mt-3 w-full"
      ></canvas>
    </div>
    <div class="rounded-xl border border-border bg-background/50 p-3">
      <h3 class="text-sm font-medium">{selectedTool?.name ?? 'Ship tool'}</h3>
      <canvas bind:this={tool} aria-label="Selected ship tool schematic" class="mt-3 w-full"
      ></canvas>
    </div>
  </section>

  <section aria-label="Ship tools" class="grid gap-3">
    <h3 class="text-sm font-semibold">Tools</h3>
    <div class="grid gap-2 sm:grid-cols-3">
      {#each view.tools as option (option.id)}
        <Button
          variant={option.selected ? 'secondary' : 'outline'}
          aria-pressed={option.selected}
          disabled={!option.available}
          onclick={() => onutility(option.id)}
          class="min-h-11 h-auto min-w-0 flex-col items-start gap-1 whitespace-normal px-3 py-3 text-left"
        >
          <span>{option.name}{option.selected ? ' · Selected' : ''}</span>
          {#if !option.available}
            <span class="text-xs font-normal text-muted-foreground"
              >Locked · Find in spider nests</span
            >
          {/if}
        </Button>
      {/each}
    </div>
    {#if selectedTool}
      <p class="text-sm leading-relaxed text-muted-foreground">{selectedTool.copy}</p>
    {/if}
  </section>

  <section aria-labelledby="inventory-satellites-title" class="grid gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 id="inventory-satellites-title" class="text-sm font-semibold">
        Satellites <span class="font-normal text-muted-foreground">({view.total})</span>
      </h3>
      <p class="text-xs text-muted-foreground">Spider silk: {view.silk}</p>
    </div>
    <p class="text-sm leading-relaxed text-muted-foreground">{view.description}</p>
    {#if items.length === 0}
      <p class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        No satellites stored. Fly near a loose satellite to collect it.
      </p>
    {:else}
      <ul class="grid gap-2">
        {#each items as item (item.id)}
          <li
            class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
          >
            <div class="min-w-0">
              <p class="break-words text-sm font-medium">{item.name}</p>
              <p class="text-xs leading-relaxed text-muted-foreground">
                {item.health}/{item.maxHealth} HP · {item.remainingSeconds}s {item.equipped
                  ? 'remaining'
                  : 'lifetime'}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={item.equipped || !view.canEquipSatellite}
              data-inventory-equip={item.id}
              aria-label={`${item.equipped ? 'Equipped' : 'Equip'} ${item.name}`}
              onclick={() => onequip(item.id)}
              class="min-h-11">{item.equipped ? 'Equipped' : 'Equip'}</Button
            >
          </li>
        {/each}
      </ul>
    {/if}

    {#if view.pages > 1}
      <nav
        aria-label="Satellite inventory pages"
        class="flex flex-wrap items-center justify-between gap-2"
      >
        <Button variant="outline" disabled={view.page === 0} onclick={() => onpage(view.page - 1)}
          >Previous</Button
        >
        <span class="text-xs text-muted-foreground" aria-live="polite"
          >Page {view.page + 1} of {view.pages}</span
        >
        <Button
          variant="outline"
          disabled={view.page + 1 >= view.pages}
          onclick={() => onpage(view.page + 1)}>Next</Button
        >
      </nav>
    {/if}
  </section>

  <Button bind:ref={returnButton} onclick={onclose} class="min-h-11 w-full">Return to flight</Button
  >
</div>

<style>
  .inventory-panel {
    font-family: var(--font-sans);
  }
</style>
