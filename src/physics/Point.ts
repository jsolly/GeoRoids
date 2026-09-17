export class Point {
  constructor(
    readonly x: number,
    readonly y: number
  ) {}

  distance(targetPoint: Point): number {
    return Math.floor(Math.hypot(this.x - targetPoint.x, this.y - targetPoint.y));
  }
}
