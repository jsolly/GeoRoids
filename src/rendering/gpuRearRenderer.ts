import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import type { ContourLevel } from '../physics/terrain/contours';
import { GpuResources } from './gpuResources';
import {
  GPU_COMPOSITE_FRAGMENT,
  GPU_COMPOSITE_VERTEX,
  GPU_REAR_FRAGMENT,
  GPU_SEGMENT_FRAGMENT,
  GPU_SEGMENT_VERTEX,
} from './gpuShaders';

type Segment = ContourLevel['segments'][number];
export type GpuContourLayer = { index: number; segments: readonly Segment[] };
type GpuRearScene = {
  position: Position;
  width: number;
  height: number;
  dpr: number;
  scale: number;
  zoom: number;
  rotation: number;
  contourTransform?: { a: number; b: number; c: number; d: number };
  contours: readonly GpuContourLayer[];
  rearSource: HTMLCanvasElement;
  nativeStars: number;
  nativeStarRects: number;
};

type Batch = {
  buffer: WebGLBuffer;
  array: WebGLVertexArrayObject;
  anchorX: number;
  anchorY: number;
  count: number;
  bytes: number;
  frame: number;
};

type CameraUniforms = {
  camera: WebGLUniformLocation;
  rotation: WebGLUniformLocation;
  size: WebGLUniformLocation;
  view: WebGLUniformLocation;
  scale: WebGLUniformLocation;
};
type CameraProgram = CameraUniforms & { program: WebGLProgram };
type ReadyResources = {
  owner: GpuResources;
  segments: CameraProgram & { radius: WebGLUniformLocation };
  rear: {
    program: WebGLProgram;
    array: WebGLVertexArrayObject;
    source: WebGLUniformLocation;
  };
  composite: {
    program: WebGLProgram;
    array: WebGLVertexArrayObject;
    size: WebGLUniformLocation;
    ink: WebGLUniformLocation;
    coverage: WebGLUniformLocation;
  };
  mask: WebGLTexture;
  rearTexture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  maskWidth: number;
  maskHeight: number;
  contours: Map<readonly Segment[], Batch>;
};
type GpuState =
  | { kind: 'ready'; resources: ReadyResources }
  | { kind: 'context-lost' }
  | { kind: 'failed' }
  | { kind: 'destroyed' };

type ContourPainter =
  | { contourMode: 'none' | 'gpu-capsules'; contourReason: 'none' }
  | { contourMode: 'canvas-path'; contourReason: 'hairline' | 'rotated-path-coverage' };

export type GpuFrameStats = ContourPainter & {
  state: GpuState['kind'];
  workload: 'native-rear-gpu-contours';
  nativeContourSegments: number;
  totalNativeContourSegments: number;
  frames: number;
  drawCalls: number;
  geometryUploads: number;
  uploadedBytes: number;
  submittedStars: number;
  submittedSegments: number;
  retainedBuffers: number;
  retainedBytes: number;
  maskBytes: number;
  rearTextureBytes: number;
  rearTextureUploads: number;
  rearTextureUploadBytes: number;
  totalRearTextureUploads: number;
  totalRearTextureUploadBytes: number;
  nativeStars: number;
  nativeStarRects: number;
  totalNativeStars: number;
  totalNativeStarRects: number;
  contextLosses: number;
  contextRestorations: number;
  totalDrawCalls: number;
  totalGeometryUploads: number;
  totalUploadedBytes: number;
  rearBlits: number;
  totalRearBlits: number;
};

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ];
}
const BACKGROUND = rgb(PALETTE.BG);
const CONTOUR_COLOR = rgb(PALETTE.CONTOUR);

/** Only contiguous rear layers. The opaque Canvas receives one synchronous rear blit. */
export class GpuRearRenderer {
  private state: GpuState = { kind: 'failed' };
  private contourPainter: ContourPainter = { contourMode: 'none', contourReason: 'none' };
  private readonly maxSize: number;
  private readonly stats: Omit<GpuFrameStats, 'state' | keyof ContourPainter> = {
    workload: 'native-rear-gpu-contours',
    nativeContourSegments: 0,
    totalNativeContourSegments: 0,
    frames: 0,
    drawCalls: 0,
    geometryUploads: 0,
    uploadedBytes: 0,
    submittedStars: 0,
    submittedSegments: 0,
    retainedBuffers: 0,
    retainedBytes: 0,
    maskBytes: 0,
    rearTextureBytes: 0,
    rearTextureUploads: 0,
    rearTextureUploadBytes: 0,
    totalRearTextureUploads: 0,
    totalRearTextureUploadBytes: 0,
    nativeStars: 0,
    nativeStarRects: 0,
    totalNativeStars: 0,
    totalNativeStarRects: 0,
    contextLosses: 0,
    contextRestorations: 0,
    totalDrawCalls: 0,
    totalGeometryUploads: 0,
    totalUploadedBytes: 0,
    rearBlits: 0,
    totalRearBlits: 0,
  };

  static create(
    overlay: HTMLCanvasElement,
    onAvailabilityChange: () => void
  ): GpuRearRenderer | null {
    const parent = overlay.parentElement;
    if (!parent) {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.id = 'gameGpuCanvas';
    canvas.className = 'gpu-rear-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      return null;
    }
    const renderer = new GpuRearRenderer(canvas, gl, onAvailabilityChange);
    if (!renderer.available()) {
      renderer.destroy();
      return null;
    }
    parent.insertBefore(canvas, overlay);
    return renderer;
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly onAvailabilityChange: () => void
  ) {
    const maxSize: unknown = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxSize = typeof maxSize === 'number' ? maxSize : 0;
    canvas.hidden = true;
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
    this.initialize();
  }

  available(): boolean {
    return this.state.kind === 'ready';
  }

  /** Detached observation. No GL calls, and never invoked by a timed drawing loop. */
  getStats(): GpuFrameStats {
    return { state: this.state.kind, ...this.stats, ...this.contourPainter };
  }

  /** Keep both DOM surfaces aligned even while the GPU context is lost. */
  resizeSurface(width: number, height: number, dpr: number): void {
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== backingWidth) {
      this.canvas.width = backingWidth;
    }
    if (this.canvas.height !== backingHeight) {
      this.canvas.height = backingHeight;
    }
    const cssWidth = `${width}px`;
    const cssHeight = `${height}px`;
    if (this.canvas.style.width !== cssWidth) {
      this.canvas.style.width = cssWidth;
    }
    if (this.canvas.style.height !== cssHeight) {
      this.canvas.style.height = cssHeight;
    }
  }

  draw(scene: GpuRearScene): boolean {
    if (this.state.kind !== 'ready') {
      return false;
    }
    this.stats.drawCalls = 0;
    this.stats.geometryUploads = 0;
    this.stats.uploadedBytes = 0;
    this.stats.submittedStars = 0;
    this.stats.submittedSegments = 0;
    this.stats.nativeContourSegments = 0;
    this.contourPainter = { contourMode: 'none', contourReason: 'none' };
    this.stats.rearBlits = 0;
    this.stats.rearTextureUploads = 0;
    this.stats.rearTextureUploadBytes = 0;
    this.stats.nativeStars = 0;
    this.stats.nativeStarRects = 0;
    const resources = this.state.resources;
    try {
      this.resize(scene, resources);
      this.stats.frames++;
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.DITHER);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.clearColor(...BACKGROUND, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.drawNativeRear(scene, resources);
      // Skia switches thin strokes to a modulated hairline, with different
      // endpoint support and rounding. Preserve that native painter exactly.
      const scale = Math.fround(scene.zoom * scene.dpr * scene.scale);
      const matrix = scene.contourTransform ?? {
        a: Math.fround(scale * Math.cos(scene.rotation)),
        b: Math.fround(scale * Math.sin(scene.rotation)),
        c: Math.fround(-scale * Math.sin(scene.rotation)),
        d: Math.fround(scale * Math.cos(scene.rotation)),
      };
      const width = Math.fround(VISUAL.CONTOUR_STROKE_WIDTH / scene.scale);
      const fastLength = (x: number, y: number) => {
        const dx = Math.abs(Math.fround(width * x));
        const dy = Math.abs(Math.fround(width * y));
        return Math.fround(Math.max(dx, dy) + Math.min(dx, dy) / 2);
      };
      // A whole native rotated Path2D can have different coverage from the
      // maximum of isolated capsules. Keep its complete source-ordered painter.
      this.contourPainter =
        fastLength(matrix.a, matrix.b) <= 1 && fastLength(matrix.c, matrix.d) <= 1
          ? { contourMode: 'canvas-path', contourReason: 'hairline' }
          : scene.rotation !== 0
            ? { contourMode: 'canvas-path', contourReason: 'rotated-path-coverage' }
            : { contourMode: 'gpu-capsules', contourReason: 'none' };
      if (this.contourPainter.contourMode === 'gpu-capsules') {
        this.drawContours(scene, resources);
      }
      this.prune(resources.contours, resources.owner);
      this.stats.totalDrawCalls += this.stats.drawCalls;
      this.stats.totalGeometryUploads += this.stats.geometryUploads;
      this.stats.totalUploadedBytes += this.stats.uploadedBytes;
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.canvas.hidden = false;
      return true;
    } catch {
      this.retire();
      return false;
    }
  }

  destroy(): void {
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    if (this.state.kind === 'ready') {
      this.state.resources.owner.destroy();
    }
    this.state = { kind: 'destroyed' };
    this.clearRetainedStats();
    // Release the browser context as well as its explicitly owned objects.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }

  composeInto(context: CanvasRenderingContext2D): boolean {
    if (this.state.kind !== 'ready') {
      return false;
    }
    context.save();
    try {
      // World painters may be inside the scan transform. Copy backing pixels
      // exactly, then restore that transform for all ordinary Canvas painters.
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(this.canvas, 0, 0);
      this.stats.rearBlits++;
      this.stats.totalRearBlits++;
      return true;
    } catch {
      this.retire();
      return false;
    } finally {
      context.restore();
    }
  }

  recordNativeContours(segments: number): void {
    if (this.state.kind === 'ready' && this.contourPainter.contourMode === 'canvas-path') {
      this.stats.nativeContourSegments += segments;
      this.stats.totalNativeContourSegments += segments;
    }
  }

  private readonly contextLost = (event: Event): void => {
    event.preventDefault();
    if (this.state.kind === 'destroyed') {
      return;
    }
    // Objects from the old context are invalid. Never reuse them on restoration.
    this.state = { kind: 'context-lost' };
    this.stats.contextLosses++;
    this.clearRetainedStats();
    this.canvas.hidden = true;
    this.onAvailabilityChange();
  };

  private readonly contextRestored = (): void => {
    if (this.state.kind === 'destroyed') {
      return;
    }
    this.initialize();
    this.stats.contextRestorations++;
    this.onAvailabilityChange();
  };

  private initialize(): void {
    const gl = this.gl;
    const owner = new GpuResources(gl);
    try {
      const segmentProgram = owner.program(GPU_SEGMENT_VERTEX, GPU_SEGMENT_FRAGMENT);
      const rearProgram = owner.program(GPU_COMPOSITE_VERTEX, GPU_REAR_FRAGMENT);
      const compositeProgram = owner.program(GPU_COMPOSITE_VERTEX, GPU_COMPOSITE_FRAGMENT);
      const cameraUniforms = (program: WebGLProgram): CameraProgram => ({
        program,
        camera: owner.uniform(program, 'u_camera'),
        rotation: owner.uniform(program, 'u_rotation'),
        size: owner.uniform(program, 'u_size'),
        view: owner.uniform(program, 'u_view'),
        scale: owner.uniform(program, 'u_scale'),
      });
      this.state = {
        kind: 'ready',
        resources: {
          owner,
          segments: {
            ...cameraUniforms(segmentProgram),
            radius: owner.uniform(segmentProgram, 'u_radius'),
          },
          rear: {
            program: rearProgram,
            array: owner.vertexArray(),
            source: owner.uniform(rearProgram, 'u_rear'),
          },
          composite: {
            program: compositeProgram,
            array: owner.vertexArray(),
            size: owner.uniform(compositeProgram, 'u_size'),
            ink: owner.uniform(compositeProgram, 'u_ink'),
            coverage: owner.uniform(compositeProgram, 'u_coverage'),
          },
          mask: owner.texture(),
          rearTexture: owner.texture(),
          framebuffer: owner.framebuffer(),
          maskWidth: 0,
          maskHeight: 0,
          contours: new Map(),
        },
      };
    } catch {
      owner.destroy();
      this.state = { kind: 'failed' };
    }
  }

  private resize(scene: GpuRearScene, resources: ReadyResources): void {
    const width = Math.max(1, Math.round(scene.width * scene.dpr));
    const height = Math.max(1, Math.round(scene.height * scene.dpr));
    if (width > this.maxSize || height > this.maxSize) {
      throw new Error('GPU viewport exceeds the supported texture size');
    }
    this.resizeSurface(scene.width, scene.height, scene.dpr);
    if (resources.maskWidth === width && resources.maskHeight === height) {
      return;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, resources.mask);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resources.mask, 0);
    // Only initialization/resize may query GL status. Frames reuse this complete target.
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('GPU contour coverage target is incomplete');
    }
    gl.bindTexture(gl.TEXTURE_2D, resources.rearTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.stats.rearTextureBytes = width * height * 4;
    resources.maskWidth = width;
    resources.maskHeight = height;
    this.stats.maskBytes = width * height;
  }

  private setCamera(
    program: CameraProgram,
    scene: GpuRearScene,
    batch: Batch,
    scale: number
  ): void {
    const gl = this.gl;
    gl.uniform2f(
      program.camera,
      scene.position.x - batch.anchorX,
      scene.position.y - batch.anchorY
    );
    gl.uniform2f(program.rotation, Math.cos(scene.rotation), Math.sin(scene.rotation));
    gl.uniform2f(program.size, this.canvas.width, this.canvas.height);
    gl.uniform2f(program.view, scene.width * scene.dpr, scene.height * scene.dpr);
    gl.uniform1f(program.scale, scale);
  }

  private drawNativeRear(scene: GpuRearScene, resources: ReadyResources): void {
    if (
      scene.rearSource.width !== this.canvas.width ||
      scene.rearSource.height !== this.canvas.height
    ) {
      throw new Error('Native rear source backing dimensions do not match');
    }
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resources.rearTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene.rearSource);
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    const bytes = this.canvas.width * this.canvas.height * 4;
    this.stats.rearTextureUploads++;
    this.stats.rearTextureUploadBytes += bytes;
    this.stats.totalRearTextureUploads++;
    this.stats.totalRearTextureUploadBytes += bytes;
    this.stats.nativeStars = scene.nativeStars;
    this.stats.nativeStarRects = scene.nativeStarRects;
    this.stats.totalNativeStars += scene.nativeStars;
    this.stats.totalNativeStarRects += scene.nativeStarRects;
    gl.useProgram(resources.rear.program);
    gl.uniform1i(resources.rear.source, 0);
    gl.bindVertexArray(resources.rear.array);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.drawCalls++;
    gl.enable(gl.BLEND);
  }

  private drawContours(scene: GpuRearScene, resources: ReadyResources): void {
    const gl = this.gl;
    for (const layer of scene.contours) {
      const first = layer.segments[0];
      if (!first) {
        continue;
      }
      let batch = resources.contours.get(layer.segments);
      if (!batch) {
        const data = new Float32Array(layer.segments.length * 4);
        for (const [index, segment] of layer.segments.entries()) {
          data[index * 4] = segment.ax - first.ax;
          data[index * 4 + 1] = segment.ay - first.ay;
          data[index * 4 + 2] = segment.bx - first.ax;
          data[index * 4 + 3] = segment.by - first.ay;
        }
        batch = this.upload(resources.owner, data, 4, first.ax, first.ay);
        resources.contours.set(layer.segments, batch);
      }
      batch.frame = this.stats.frames;
      gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer);
      // Sampling the mask while it is attached for drawing is invalid, even if
      // the active segment shader never uses a sampler. Unbind it explicitly.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // One Canvas stroke covers a whole level once. MAX preserves that union
      // instead of accumulating brightness at connected endpoints/intersections.
      gl.blendEquation(gl.MAX);
      gl.useProgram(resources.segments.program);
      this.setCamera(resources.segments, scene, batch, scene.scale * scene.zoom * scene.dpr);
      gl.uniform1f(
        resources.segments.radius,
        (VISUAL.CONTOUR_STROKE_WIDTH * scene.zoom * scene.dpr) / 2
      );
      gl.bindVertexArray(batch.array);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.count);
      this.stats.drawCalls++;
      this.stats.submittedSegments += batch.count;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(resources.composite.program);
      gl.bindTexture(gl.TEXTURE_2D, resources.mask);
      gl.uniform1i(resources.composite.coverage, 0);
      gl.uniform2f(resources.composite.size, this.canvas.width, this.canvas.height);
      const alpha =
        layer.index % VISUAL.CONTOUR_INDEX_EVERY === 0
          ? VISUAL.CONTOUR_INDEX_ALPHA
          : VISUAL.CONTOUR_ALPHA;
      gl.uniform4f(resources.composite.ink, ...CONTOUR_COLOR, Math.round(alpha * 100) / 100);
      gl.bindVertexArray(resources.composite.array);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.stats.drawCalls++;
    }
  }

  private upload(
    owner: GpuResources,
    data: Float32Array,
    components: number,
    anchorX: number,
    anchorY: number
  ): Batch {
    const gl = this.gl;
    const buffer = owner.buffer();
    const array = owner.vertexArray();
    gl.bindVertexArray(array);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, components, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 1);
    this.stats.geometryUploads++;
    this.stats.uploadedBytes += data.byteLength;
    this.stats.retainedBuffers++;
    this.stats.retainedBytes += data.byteLength;
    return {
      buffer,
      array,
      anchorX,
      anchorY,
      count: data.length / components,
      bytes: data.byteLength,
      frame: this.stats.frames,
    };
  }

  private prune<T>(batches: Map<T, Batch>, owner: GpuResources): void {
    for (const [key, batch] of batches) {
      if (batch.frame !== this.stats.frames) {
        owner.releaseBatch(batch.buffer, batch.array);
        batches.delete(key);
        this.stats.retainedBuffers--;
        this.stats.retainedBytes -= batch.bytes;
      }
    }
  }

  private retire(): void {
    if (this.state.kind === 'ready') {
      this.state.resources.owner.destroy();
    }
    this.state = { kind: 'failed' };
    this.clearRetainedStats();
    this.canvas.hidden = true;
    this.onAvailabilityChange();
  }

  private clearRetainedStats(): void {
    this.contourPainter = { contourMode: 'none', contourReason: 'none' };
    this.stats.nativeContourSegments = 0;
    this.stats.drawCalls = 0;
    this.stats.geometryUploads = 0;
    this.stats.uploadedBytes = 0;
    this.stats.submittedStars = 0;
    this.stats.submittedSegments = 0;
    this.stats.retainedBuffers = 0;
    this.stats.retainedBytes = 0;
    this.stats.maskBytes = 0;
    this.stats.rearTextureBytes = 0;
    this.stats.rearTextureUploads = 0;
    this.stats.rearTextureUploadBytes = 0;
    this.stats.nativeStars = 0;
    this.stats.nativeStarRects = 0;
    this.stats.rearBlits = 0;
  }
}
