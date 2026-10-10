<script lang="ts">
  import { flushSync, onMount, untrack } from 'svelte';
  import type {
    PhoneCollectorDownload,
    PhoneCollectorView,
  } from '../../diagnostics/phoneCollector';
  import Button from '../ui/button/button.svelte';
  import Input from '../ui/input/input.svelte';

  let {
    view,
    inPlay = true,
    onstart,
    onstop,
    onrecover,
    ondownload,
  }: {
    view: PhoneCollectorView;
    inPlay?: boolean;
    onstart: (device: string, conditions: string) => void;
    onstop: () => void;
    onrecover: () => void;
    ondownload: () => Promise<PhoneCollectorDownload | null>;
  } = $props();
  let device = $state('');
  let conditions = $state('');
  let savedDevice: string | undefined;
  let savedConditions: string | undefined;
  $effect(() => {
    const nextDevice = view.device;
    const nextConditions = view.conditions;
    // Preserve local drafts across unrelated runtime updates; recovery replaces saved metadata.
    untrack(() => {
      if (nextDevice !== savedDevice || nextConditions !== savedConditions) {
        device = nextDevice;
        conditions = nextConditions;
        savedDevice = nextDevice;
        savedConditions = nextConditions;
      }
    });
  });
  const recording = $derived(view.phase === 'recording');
  const busy = $derived(recording || view.phase === 'starting' || view.phase === 'recovering');
  let panel: HTMLElement;
  let statusNode: HTMLSpanElement;
  let anchor: HTMLAnchorElement;
  let downloadUrl = $state<string | undefined>();
  let filename = $state('');
  let downloadError = $state('');
  let pending = $state(false);
  let alive = false;
  let previousPhase: PhoneCollectorView['phase'] | undefined;
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();

  $effect.pre(() => {
    const phase = view.phase;
    if (phase !== previousPhase && panel?.contains(document.activeElement)) {
      statusNode?.focus();
    }
    previousPhase = phase;
  });

  onMount(() => {
    alive = true;
    return () => {
      alive = false;
      for (const [url, timer] of downloads) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloads.clear();
    };
  });

  async function download() {
    if (!view.canDownload || pending) {
      return;
    }
    pending = true;
    downloadError = '';
    try {
      const result = await ondownload();
      if (!alive || !result) {
        return;
      }
      const url = URL.createObjectURL(result.blob);
      downloads.set(
        url,
        setTimeout(() => {
          URL.revokeObjectURL(url);
          downloads.delete(url);
        }, 1000)
      );
      flushSync(() => {
        downloadUrl = url;
        filename = result.filename;
      });
      anchor.click();
    } catch (error) {
      if (alive) {
        downloadError = `Download failed: ${error instanceof Error ? error.message.slice(0, 256) : 'unknown error'}`;
      }
    } finally {
      if (alive) {
        pending = false;
      }
    }
  }
</script>

<aside
  bind:this={panel}
  aria-label="Performance collection"
  class:in-play={inPlay}
  class="phone-collector rounded-lg border border-border bg-background p-3 text-sm text-foreground shadow-lg"
>
  <span bind:this={statusNode} role="status" aria-live="polite" aria-atomic="true" tabindex="-1"
    >{downloadError || view.status}</span
  >
  <div class="mt-2 flex flex-wrap gap-2">
    {#if !recording}
      <Button size="sm" disabled={!view.canStart} onclick={() => onstart(device, conditions)}
        >Start</Button
      >
    {/if}
    <Button size="sm" disabled={!view.canStop} onclick={onstop}>Stop</Button>
    {#if !recording}
      <Button size="sm" disabled={!view.canDownload || pending} onclick={download}>Download</Button>
      <Button size="sm" variant="outline" disabled={!view.canRecover} onclick={onrecover}
        >Recover last session</Button
      >
    {/if}
  </div>
  {#if !recording}
    <details class="mt-2">
      <summary class="min-h-11 cursor-pointer py-3">Device and conditions</summary>
      <p class="my-2 text-xs text-muted-foreground">
        Model and conditions are required for comparisons. Starting replaces the saved session;
        download it first.
      </p>
      <div class="grid gap-2">
        <Input
          aria-label="Device model and OS"
          placeholder="Device model and OS"
          maxlength={256}
          disabled={busy}
          bind:value={device}
        />
        <Input
          aria-label="Test conditions"
          placeholder="Power, brightness, network, cooldown"
          maxlength={512}
          disabled={busy}
          bind:value={conditions}
        />
      </div>
    </details>
  {/if}
  <a
    bind:this={anchor}
    href={downloadUrl}
    download={filename}
    hidden
    aria-hidden="true"
    tabindex="-1">Download performance recording</a
  >
</aside>

<style>
  .phone-collector {
    position: relative;
    width: min(24rem, calc(100vw - 24px));
    margin: 1rem auto;
    font-family: var(--font-sans);
  }
  .phone-collector.in-play {
    position: fixed;
    margin: 0;
    left: max(12px, env(safe-area-inset-left));
    bottom: max(100px, calc(env(safe-area-inset-bottom) + 88px));
    z-index: 10000;
    width: min(24rem, calc(100vw - 24px));
    max-height: 30dvh;
    overflow: auto;
    font-family: var(--font-sans);
  }
  @media (max-width: 639px) {
    .phone-collector.in-play {
      max-height: min(30dvh, var(--mobile-diagnostic-max-height, 30dvh));
    }
  }
</style>
