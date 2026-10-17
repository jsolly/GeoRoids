<script lang="ts">
  import type { Snippet } from 'svelte';
  import { focusReturnTarget, isExternalFocusTarget } from '../../ui/focusReturn';
  import Button from '../ui/button/button.svelte';
  import Dialog from '../ui/dialog/dialog.svelte';
  import DialogClose from '../ui/dialog/dialog-close.svelte';
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

  let content = $state<HTMLDivElement | null>(null);
  let opener: HTMLElement | null = null;

  function requestOpen(next: boolean) {
    if (!next && open) {
      onclose();
    }
  }

  function openFocus() {
    if (
      document.activeElement instanceof HTMLElement &&
      isExternalFocusTarget(document.activeElement)
    ) {
      opener = document.activeElement;
    }
  }

  function closeFocus(event: Event) {
    event.preventDefault();
    if (!open && restoreFocus === true) {
      const target = focusReturnTarget(closeFocusTarget?.(), opener, fallbackFocusTarget?.());
      if (target) {
        target.focus();
      }
    }
  }

  $effect(() => {
    const node = content;
    if (!node) {
      return;
    }
    const viewport = window.visualViewport;
    const fitViewport = () => {
      node.style.setProperty(
        '--overlay-viewport-width',
        `${viewport?.width ?? window.innerWidth}px`
      );
      node.style.setProperty(
        '--overlay-viewport-height',
        `${viewport?.height ?? window.innerHeight}px`
      );
      node.style.setProperty('--overlay-viewport-left', `${viewport?.offsetLeft ?? 0}px`);
      node.style.setProperty('--overlay-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    };
    fitViewport();
    window.addEventListener('resize', fitViewport);
    viewport?.addEventListener('resize', fitViewport);
    viewport?.addEventListener('scroll', fitViewport);
    return () => {
      window.removeEventListener('resize', fitViewport);
      viewport?.removeEventListener('resize', fitViewport);
      viewport?.removeEventListener('scroll', fitViewport);
    };
  });
</script>

<Dialog bind:open={() => open, requestOpen}>
  <SheetContent
    side="bottom"
    bind:ref={content}
    showCloseButton={false}
    onOpenAutoFocus={openFocus}
    onCloseAutoFocus={closeFocus}
    class="game-overlay gap-6 rounded-xl p-6 ring-1 ring-foreground/10"
  >
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
  </SheetContent>
</Dialog>

<style>
  :global([data-slot='sheet-overlay']:has(~ .game-overlay)) {
    z-index: 1500;
  }
  :global(.game-overlay) {
    z-index: 1600;
    font-family: var(--font-sans);
    display: grid;
    right: auto;
    bottom: auto;
    height: auto;
    top: calc(var(--overlay-viewport-top, 0px) + var(--overlay-viewport-height, 100dvh) / 2);
    left: calc(var(--overlay-viewport-left, 0px) + var(--overlay-viewport-width, 100vw) / 2);
    width: min(42rem, calc(var(--overlay-viewport-width, 100vw) - 2rem));
    max-width: none;
    max-height: calc(var(--overlay-viewport-height, 100dvh) * 0.85);
    grid-template-rows: auto minmax(0, 1fr);
    translate: -50% -50%;
  }
  @media (max-width: 639px) {
    :global(.game-overlay) {
      top: calc(var(--overlay-viewport-top, 0px) + var(--overlay-viewport-height, 100dvh));
      left: var(--overlay-viewport-left, 0px);
      width: var(--overlay-viewport-width, 100vw);
      max-height: calc(var(--overlay-viewport-height, 100dvh) * 0.9);
      gap: 1.25rem;
      border-radius: 1rem 1rem 0 0;
      padding: 1.25rem;
      padding-bottom: max(1.25rem, env(safe-area-inset-bottom));
      translate: 0 -100%;
    }
  }
</style>
