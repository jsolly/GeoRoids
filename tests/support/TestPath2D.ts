export interface TestPathCommand {
  kind: 'moveTo' | 'lineTo';
  x: number;
  y: number;
}

/** Minimal command recorder for focused renderer tests in the jsdom Canvas environment. */
export class TestPath2D {
  readonly commands: TestPathCommand[] = [];

  moveTo(x: number, y: number): void {
    this.commands.push({ kind: 'moveTo', x, y });
  }

  lineTo(x: number, y: number): void {
    this.commands.push({ kind: 'lineTo', x, y });
  }
}
