<script lang="ts">
  import { tick } from 'svelte';
  import { formatDebugDiagnostics } from '../../../shared/debugReports';
  import type { DebugDiagnosticSnapshot } from '../../../shared-types';
  import type { DebugReportClientView } from '../../diagnostics/debugReportClient';
  import { createReportInputDiagnostics } from '../../diagnostics/reportInputDiagnostics';
  import Button from '../ui/button/button.svelte';
  import CopyControl from './CopyControl.svelte';

  let {
    description = $bindable(''),
    snapshot,
    view,
    onsend,
    onretry,
    onnew,
    onclose,
  }: {
    description?: string;
    snapshot: DebugDiagnosticSnapshot | null;
    view: DebugReportClientView;
    onsend: (description: string, diagnostics: DebugDiagnosticSnapshot) => void;
    onretry: () => void;
    onclose: () => void;
    onnew: () => Promise<boolean>;
  } = $props();
  const receiptOnly = $derived(view.reportId !== null && view.submission === null);
  const locked = $derived(view.submission !== null || view.state === 'sending');
  let descriptionField: HTMLTextAreaElement | undefined;
  let inputDiagnostics = $state.raw<ReturnType<typeof createReportInputDiagnostics> | null>(null);
  function recordInput(field: HTMLTextAreaElement) {
    descriptionField = field;
    const recorder = createReportInputDiagnostics(field);
    inputDiagnostics = recorder;
    return () => {
      recorder.dispose();
      if (descriptionField === field) {
        descriptionField = undefined;
      }
      if (inputDiagnostics === recorder) {
        inputDiagnostics = null;
      }
    };
  }
  function diagnostics(): DebugDiagnosticSnapshot | null {
    if (!snapshot) {
      return null;
    }
    const input = snapshot.state['input'];
    return {
      ...snapshot,
      state: {
        ...snapshot.state,
        input: {
          ...(input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}),
          reportForm: inputDiagnostics?.read() ?? null,
        },
      },
    };
  }
  function bundle(): string {
    if (view.submission) {
      return JSON.stringify(
        {
          id: view.submission.id,
          description: view.submission.description,
          submittedAt: view.submission.submittedAt,
          diagnostics: view.submission.diagnostics,
        },
        null,
        2
      );
    }
    const captured = diagnostics();
    return `${description}\n\n${captured ? formatDebugDiagnostics(captured) : ''}`;
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    const captured = diagnostics();
    if (captured && view.canSend && description.trim()) {
      onsend(description, captured);
    }
  }
  async function startNewReport() {
    if (await onnew()) {
      await tick();
      if (descriptionField?.isConnected) {
        descriptionField.focus();
      }
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([bundle()], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `georoids-debug-${view.reportId ?? 'draft'}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
</script>

<form class="grid gap-4" onsubmit={submit}>
  {#if !receiptOnly}
    <div class="grid gap-2">
      <label for="debug-report-description">What happened?</label>
      <textarea
        {@attach recordInput}
        id="debug-report-description"
        class="min-h-32 rounded-md border border-input bg-background p-3 text-base"
        required
        minlength="1"
        maxlength="4000"
        disabled={locked}
        value={view.submission?.description ?? description}
        oninput={(event) => {
          description = event.currentTarget.value;
        }}
        aria-describedby="debug-report-privacy"></textarea>
      <p id="debug-report-privacy" class="text-sm text-muted-foreground">
        Include what you expected and what happened. Do not include passwords or secrets. Your
        description and redacted diagnostics are shared with the GeoRoids project team.
      </p>
    </div>
  {/if}
  <p role="status" aria-live="polite">{view.message}</p>
  {#if view.reportId}<p class="break-all text-xs text-muted-foreground">
      Report: {view.reportId}
    </p>{/if}
  {#if !receiptOnly}
    <details>
      <summary class="cursor-pointer text-sm">Diagnostic preview</summary>
      <pre
        class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{bundle()}</pre>
    </details>
    <div class="flex flex-wrap gap-2">
      <CopyControl id="copy-debug-report" name="report" label="Copy report" value={bundle} />
      <Button type="button" variant="outline" onclick={download}>Download report</Button>
    </div>
  {/if}
  <div class="flex flex-wrap gap-2">
    {#if !receiptOnly}<Button
        type="submit"
        disabled={!view.canSend || !snapshot || !description.trim()}>Send</Button
      >{/if}
    {#if view.reportId && view.state !== 'delivered'}<Button
        type="button"
        variant="outline"
        disabled={view.state === 'sending'}
        onclick={onretry}>Retry / check delivery</Button
      >{/if}
    {#if view.reportId && !view.submission && view.state !== 'sending'}<Button
        type="button"
        variant="outline"
        onclick={startNewReport}>New report</Button
      >{/if}
    <Button type="button" variant="outline" onclick={onclose}
      >{receiptOnly ? 'Close' : 'Cancel'}</Button
    >
  </div>
</form>
