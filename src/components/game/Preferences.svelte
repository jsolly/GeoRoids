<script lang="ts">
  import type { GameMenuView, GamePreference } from '../../runtime/uiTypes';
  import Checkbox from '../ui/checkbox/checkbox.svelte';

  let {
    preferences,
    disabled = false,
    onpreference,
  }: {
    preferences: GameMenuView['preferences'];
    disabled?: boolean;
    onpreference: (kind: GamePreference, enabled: boolean) => void;
  } = $props();

  const options = [
    { kind: 'sound', label: 'Sound' },
    { kind: 'music', label: 'Music' },
    { kind: 'haptics', label: 'Haptics' },
  ] satisfies { kind: GamePreference; label: string }[];
</script>

<fieldset class="min-w-0">
  <legend class="sr-only">Preferences</legend>
  <div class="flex flex-wrap gap-x-5 gap-y-1">
    {#each options as option (option.kind)}
      {#if option.kind !== 'haptics' || preferences.hapticsAvailable}
        <label
          for={`preference-${option.kind}`}
          class="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted-foreground has-disabled:cursor-not-allowed has-disabled:opacity-50"
        >
          <Checkbox
            id={`preference-${option.kind}`}
            checked={preferences[option.kind]}
            {disabled}
            onCheckedChange={(enabled) => {
              if (!disabled) {
                onpreference(option.kind, enabled);
              }
            }}
          />
          {option.label}
        </label>
      {/if}
    {/each}
  </div>
</fieldset>
