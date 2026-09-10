/** Canvas operations used by the vector painters, supported in browsers and
 * the native canvas used to record manual demonstrations. No DOM element or
 * browser-only canvas features are required by these painters. */
export type DrawingContext = Pick<
  CanvasRenderingContext2D,
  | 'arc'
  | 'beginPath'
  | 'closePath'
  | 'createRadialGradient'
  | 'ellipse'
  | 'fillRect'
  | 'fillStyle'
  | 'fillText'
  | 'font'
  | 'globalAlpha'
  | 'lineCap'
  | 'lineJoin'
  | 'lineTo'
  | 'lineWidth'
  | 'moveTo'
  | 'rect'
  | 'restore'
  | 'rotate'
  | 'roundRect'
  | 'save'
  | 'scale'
  | 'setLineDash'
  | 'shadowBlur'
  | 'shadowColor'
  | 'strokeRect'
  | 'strokeStyle'
  | 'textAlign'
  | 'textBaseline'
  | 'translate'
> & {
  fill(fillRule?: CanvasFillRule): void;
  stroke(): void;
  measureText(text: string): Pick<TextMetrics, 'width'>;
};
