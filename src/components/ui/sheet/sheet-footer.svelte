<script lang="ts">
  import { cn } from 'cn';
  import type { HTMLAttributes } from 'svelte/elements';
  import type { WithElementRef } from '../../../ui-utils';

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
  bind:this={ref}
  data-slot="sheet-footer"
  class={cn('gap-2 p-4 mt-auto flex flex-col', className)}
  {...restProps}
>
  {@render children?.()}
</div>
