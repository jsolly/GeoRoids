<script lang="ts">
  import { onMount, type Snippet, tick } from 'svelte';
  import Button from '../ui/button/button.svelte';
  import Dialog from '../ui/dialog/dialog.svelte';
  import DialogClose from '../ui/dialog/dialog-close.svelte';
  import DialogContent from '../ui/dialog/dialog-content.svelte';
  import DialogDescription from '../ui/dialog/dialog-description.svelte';
  import DialogTitle from '../ui/dialog/dialog-title.svelte';
  import SheetContent from '../ui/sheet/sheet-content.svelte';

  let {
    open,
    title,
    description,
    onclose,
    children,
    closeFocusTarget,
    fallbackFocusTarget,
    restoreFocus = true,
  }: {
    open: boolean;
    title: string;
    description: string;
    onclose: () => void;
    children: Snippet;
    closeFocusTarget?: () => HTMLElement | null;
    fallbackFocusTarget?: () => HTMLElement | null;
    restoreFocus?: boolean;
  } = $props();

  let mobile = $state(false);
  let content = $state<HTMLDivElement | null>(null);
  let opener: HTMLElement | null = null;
  let switchingFocus: number | null = null;
  let live = true;
  const focusable =
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';

  function requestOpen(next: boolean) {
    if (!next && open) {
      onclose();
    }
  }

  function usableFocusTarget(target: HTMLElement | null | undefined): target is HTMLElement {
    if (
      !target?.isConnected ||
      target === document.body ||
      target.matches(':disabled, [aria-disabled="true"]')
    ) {
      return false;
    }
    for (let ancestor: HTMLElement | null = target; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      if (
        ancestor.hidden ||
        ancestor.hasAttribute('inert') ||
        style.display === 'none' ||
        style.visibility === 'hidden'
      ) {
        return false;
      }
    }
    return true;
  }

  function externalOpener(target: HTMLElement | null | undefined): target is HTMLElement {
    return usableFocusTarget(target) && !target.closest('[role="dialog"], dialog');
  }

  function openFocus(event: Event) {
    if (switchingFocus !== null) {
      event.preventDefault();
      const index = switchingFocus;
      switchingFocus = null;
      void tick().then(() => {
        if (live && open && content) {
          const targets = content.querySelectorAll<HTMLElement>(focusable);
          (targets.item(Math.max(0, index)) ?? targets.item(0) ?? content).focus();
        }
      });
    } else if (
      document.activeElement instanceof HTMLElement &&
      externalOpener(document.activeElement)
    ) {
      opener = document.activeElement;
    }
  }

  function closeFocus(event: Event) {
    event.preventDefault();
    if (!open && restoreFocus) {
      const explicit = closeFocusTarget?.();
      const target = usableFocusTarget(explicit)
        ? explicit
        : externalOpener(opener)
          ? opener
          : fallbackFocusTarget?.();
      if (usableFocusTarget(target)) {
        target.focus();
      }
    }
  }

  onMount(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const update = () => {
      if (mobile === media.matches) {
        return;
      }
      const focused = document.activeElement;
      if (open && focused instanceof HTMLElement && content?.contains(focused)) {
        switchingFocus = [...content.querySelectorAll<HTMLElement>(focusable)].indexOf(focused);
      }
      mobile = media.matches;
    };
    update();
    media.addEventListener('change', update);
    return () => {
      live = false;
      media.removeEventListener('change', update);
    };
  });
</script>

{#snippet body()}
  <header class="grid gap-2 pr-14">
    <DialogTitle class="text-xl font-semibold">{title}</DialogTitle>
    <DialogDescription class="leading-relaxed">{description}</DialogDescription>
  </header>
  <div class="min-h-0 overflow-y-auto overscroll-contain">{@render children()}</div>
  <DialogClose>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        class="absolute top-3 right-3 min-h-11 min-w-11"
        aria-label={`Close ${title}`}
      >
        <span aria-hidden="true" class="text-xl">×</span>
      </Button>
    {/snippet}
  </DialogClose>
{/snippet}

<Dialog bind:open={() => open, requestOpen}>
  {#if mobile}
    <SheetContent
      bind:ref={content}
      side="bottom"
      showCloseButton={false}
      onOpenAutoFocus={openFocus}
      onCloseAutoFocus={closeFocus}
      class="game-overlay max-h-[90dvh] gap-5 rounded-t-2xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
    >
      {@render body()}
    </SheetContent>
  {:else}
    <DialogContent
      bind:ref={content}
      showCloseButton={false}
      onOpenAutoFocus={openFocus}
      onCloseAutoFocus={closeFocus}
      class="game-overlay max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-2xl"
    >
      {@render body()}
    </DialogContent>
  {/if}
</Dialog>

<style>
  :global([data-slot='dialog-overlay']:has(~ .game-overlay)),
  :global([data-slot='sheet-overlay']:has(~ .game-overlay)) {
    z-index: 1500;
  }
  :global(.game-overlay) {
    z-index: 1600;
    font-family: var(--font-sans);
  }
</style>
