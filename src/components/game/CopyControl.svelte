<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Button from '../ui/button/button.svelte';

  let {
    id,
    name,
    value,
    label = 'Copy',
    input,
  }: {
    id: string;
    name: string;
    value: string | (() => string);
    label?: string;
    input?: HTMLInputElement | undefined;
  } = $props();
  let result = $state<string | null>(null);
  let fallbackText = $state<string | null>(null);
  let fallback = $state<HTMLTextAreaElement | null>(null);
  let live = false;
  let generation = 0;
  let reset: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    live = true;
    return () => {
      live = false;
      generation++;
      clearTimeout(reset);
    };
  });

  function isolateActivation(event: KeyboardEvent) {
    if (event.code === 'Space' || event.code === 'Enter') {
      event.stopPropagation();
    }
  }
  async function copy() {
    const text = typeof value === 'function' ? value() : value;
    if (!text || !live) {
      return;
    }
    const ticket = ++generation;
    const current = () => live && generation === ticket;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      // A blocked clipboard falls back to the component's selectable field.
    }
    if (!current()) {
      return;
    }
    if (!copied) {
      const previous = document.activeElement;
      fallbackText = text;
      await tick();
      if (!current()) {
        return;
      }
      const target = input?.isConnected ? input : fallback;
      try {
        if (!target) {
          return;
        }
        target.focus({ preventScroll: true });
        target.select();
        target.setSelectionRange(0, text.length);
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        if (current()) {
          fallbackText = null;
          if (previous instanceof HTMLElement && previous.isConnected) {
            previous.focus({ preventScroll: true });
          }
        }
      }
    }
    if (!current()) {
      return;
    }
    result = copied ? 'Copied!' : 'Copy failed';
    clearTimeout(reset);
    reset = setTimeout(() => {
      result = null;
    }, 3000);
  }
</script>

<Button
  {id}
  variant="outline"
  class="min-h-11 shrink-0"
  disabled={typeof value === 'string' && !value}
  aria-label={result === 'Copied!' ? `Copied ${name}` : (result ?? `Copy ${name}`)}
  onkeydown={isolateActivation}
  onkeyup={isolateActivation}
  onclick={(event) => {
    event.stopPropagation();
    void copy();
  }}>{result ?? label}</Button
>
{#if fallbackText !== null}
  <textarea
    bind:this={fallback}
    value={fallbackText}
    readonly
    tabindex="-1"
    aria-label="Copy text"
    class="fixed left-0 top-0 h-px w-px opacity-0"></textarea>
{/if}
