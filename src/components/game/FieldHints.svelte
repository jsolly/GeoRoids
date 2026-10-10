<script lang="ts">
  import type { FieldHintId, FieldHintView } from '../../ui/fieldHint';
  import Button from '../ui/button/button.svelte';

  let {
    hints,
    onactivate,
  }: { hints: readonly FieldHintView[]; onactivate: (id: FieldHintId) => void } = $props();
  function gate(event: KeyboardEvent) {
    if (event.code === 'Space' || event.code === 'Enter') {
      event.stopPropagation();
    }
  }
</script>

<div role="status" class="sr-only">
  {hints.map((hint) => hint.text || hint.actionLabel).join('. ')}
</div>
{#each hints as hint (hint.id)}
  <div id={hint.id} class:above={hint.id === 'cargo-full-hint'} class="field-hint">
    {#if hint.actionLabel}
      <Button
        variant="outline"
        class="min-h-11 bg-card/95"
        onclick={(event) => {
          event.stopPropagation();
          onactivate(hint.id);
        }}
        onkeydown={gate}
        onkeyup={gate}>{hint.actionLabel}</Button
      >
    {:else}
      <span
        aria-hidden="true"
        class="block rounded-md border border-border bg-card/95 px-4 py-3 text-sm text-foreground"
        >{hint.text}</span
      >
    {/if}
  </div>
{/each}

<style>
  .field-hint {
    position: fixed;
    z-index: 24;
    left: 50%;
    max-width: calc(100vw - 32px);
    transform: translateX(-50%);
    top: min(calc(50% + 84px), calc(100% - max(20px, env(safe-area-inset-bottom)) - 112px));
    text-align: center;
    font-family: var(--font-sans);
  }
  .above {
    top: max(calc(50% - 150px), calc(env(safe-area-inset-top) + 96px));
  }
</style>
