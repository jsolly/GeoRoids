<script lang="ts">
  import type { ShipKitId } from '../../../shared-types';
  import { kitHullPickerSvg } from '../../entities/ship/hullOutlines';
  import RadioGroup from '../ui/radio-group/radio-group.svelte';
  import RadioGroupItem from '../ui/radio-group/radio-group-item.svelte';

  let {
    selectedKit,
    disabled = false,
    onselectship,
  }: {
    selectedKit: ShipKitId;
    disabled?: boolean;
    onselectship: (kit: ShipKitId) => void;
  } = $props();

  const ships = [
    { id: 'scout', name: 'Scout', description: 'Explore with Mineral Scan.' },
    { id: 'hauler', name: 'Hauler', description: 'Bring asteroids home with Tow Cable.' },
  ] satisfies { id: ShipKitId; name: string; description: string }[];

  function select(value: string) {
    if (!disabled && (value === 'scout' || value === 'hauler')) {
      onselectship(value);
    }
  }
</script>

<fieldset class="min-w-0">
  <legend class="mb-2 text-sm font-medium">Choose your ship</legend>
  <RadioGroup
    value={selectedKit}
    {disabled}
    onValueChange={select}
    aria-label="Choose your ship"
    class="grid grid-cols-2 gap-3"
  >
    {#each ships as ship (ship.id)}
      <label
        for={`ship-${ship.id}`}
        class={[
          'ship-card relative flex min-h-36 cursor-pointer flex-col rounded-xl border p-3 transition-colors',
          selectedKit === ship.id
            ? 'border-foreground/60 bg-muted/60'
            : 'border-border bg-background/50 hover:bg-muted/40',
          disabled && 'cursor-not-allowed opacity-50',
        ]}
      >
        <span class="flex items-center justify-between gap-2">
          <span aria-hidden="true" class="h-9 w-12">
            <img
              src={`data:image/svg+xml,${encodeURIComponent(kitHullPickerSvg(ship.id))}`}
              width="48"
              height="36"
              alt=""
            />
          </span>
          <RadioGroupItem
            id={`ship-${ship.id}`}
            value={ship.id}
            aria-label={ship.name}
            class="size-11 after:hidden"
          />
        </span>
        <span class="mt-2 text-base font-semibold">{ship.name}</span>
        <span class="mt-1 text-xs leading-relaxed text-muted-foreground">{ship.description}</span>
      </label>
    {/each}
  </RadioGroup>
</fieldset>

<style>
  .ship-card:focus-within {
    outline: 2px solid var(--ring);
    outline-offset: 3px;
  }
</style>
