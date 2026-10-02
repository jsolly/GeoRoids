/** Resources have one owner, including partially completed initialization. */
export class GpuResources {
  private readonly shaders = new Set<WebGLShader>();
  private readonly programs = new Set<WebGLProgram>();
  private readonly buffers = new Set<WebGLBuffer>();
  private readonly arrays = new Set<WebGLVertexArrayObject>();
  private readonly textures = new Set<WebGLTexture>();
  private readonly framebuffers = new Set<WebGLFramebuffer>();

  constructor(private readonly gl: WebGL2RenderingContext) {}

  program(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl;
    const vertex = this.shader(gl.VERTEX_SHADER, vertexSource);
    const fragment = this.shader(gl.FRAGMENT_SHADER, fragmentSource);
    const program = this.require(gl.createProgram(), 'program');
    this.programs.add(program);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    // Initialization only. No status queries occur in the animation loop.
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`GPU program initialization failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.detachShader(program, vertex);
    gl.detachShader(program, fragment);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    this.shaders.delete(vertex);
    this.shaders.delete(fragment);
    return program;
  }

  uniform(program: WebGLProgram, name: string): WebGLUniformLocation {
    return this.require(this.gl.getUniformLocation(program, name), name);
  }

  buffer(): WebGLBuffer {
    const buffer = this.require(this.gl.createBuffer(), 'buffer');
    this.buffers.add(buffer);
    return buffer;
  }

  vertexArray(): WebGLVertexArrayObject {
    const array = this.require(this.gl.createVertexArray(), 'vertex array');
    this.arrays.add(array);
    return array;
  }

  texture(): WebGLTexture {
    const texture = this.require(this.gl.createTexture(), 'texture');
    this.textures.add(texture);
    return texture;
  }

  framebuffer(): WebGLFramebuffer {
    const framebuffer = this.require(this.gl.createFramebuffer(), 'framebuffer');
    this.framebuffers.add(framebuffer);
    return framebuffer;
  }

  releaseBatch(buffer: WebGLBuffer, array: WebGLVertexArrayObject): void {
    this.gl.deleteBuffer(buffer);
    this.gl.deleteVertexArray(array);
    this.buffers.delete(buffer);
    this.arrays.delete(array);
  }

  destroy(): void {
    for (const buffer of this.buffers) {
      this.gl.deleteBuffer(buffer);
    }
    for (const array of this.arrays) {
      this.gl.deleteVertexArray(array);
    }
    for (const texture of this.textures) {
      this.gl.deleteTexture(texture);
    }
    for (const framebuffer of this.framebuffers) {
      this.gl.deleteFramebuffer(framebuffer);
    }
    for (const program of this.programs) {
      this.gl.deleteProgram(program);
    }
    for (const shader of this.shaders) {
      this.gl.deleteShader(shader);
    }
    this.buffers.clear();
    this.arrays.clear();
    this.textures.clear();
    this.framebuffers.clear();
    this.programs.clear();
    this.shaders.clear();
  }

  private shader(type: number, source: string): WebGLShader {
    const shader = this.require(this.gl.createShader(type), 'shader');
    this.shaders.add(shader);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    return shader;
  }

  private require<T>(object: T | null, name: string): T {
    if (object === null) {
      throw new Error(`GPU could not allocate ${name}`);
    }
    return object;
  }
}
