type WorldPoint = { x: number; y: number };
type EnhancedTarget = {
  id: string;
  position: WorldPoint;
  size: number;
  material?: string;
  phenomenon?: { kind: string; clusterId?: string; energy?: number; maxEnergy?: number };
};

export function captureConsole(page: import('playwright').Page): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
    if (message.type() === 'warning') {
      warnings.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return { errors, warnings };
}

export async function waitForEnhancedTargets(page: import('playwright').Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const state = window.gameController?.getAsteroidToolsController?.()?.getState?.();
      return Boolean(state?.pilot?.alive && state.targets?.length > 0);
    },
    undefined,
    { timeout: 20_000, polling: 100 }
  );
}

export function safestReflectiveCluster(
  targets: EnhancedTarget[],
  hazards: WorldPoint[]
): EnhancedTarget[] {
  const groups = new Map<string, EnhancedTarget[]>();
  for (const target of targets) {
    if (target.phenomenon?.kind !== 'reflective' || !target.phenomenon.clusterId) {
      continue;
    }
    const group = groups.get(target.phenomenon.clusterId) ?? [];
    group.push(target);
    groups.set(target.phenomenon.clusterId, group);
  }
  return (
    [...groups.values()]
      .filter((group) => group.length >= 2)
      .sort((a, b) => {
        const clearance = (group: EnhancedTarget[]) =>
          Math.min(
            ...group.flatMap((target) =>
              hazards.map((hazard) =>
                Math.hypot(target.position.x - hazard.x, target.position.y - hazard.y)
              )
            )
          );
        return clearance(b) - clearance(a);
      })[0] ?? []
  );
}
