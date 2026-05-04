/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Point2} from '../color_helpers/agtm';
import {kPrimariesP3, kTransferSrgb} from '../color_helpers/color_functions';
import '../global_interfaces';
import {Renderer} from './renderer';

const vs = `#version 300 es
            precision highp float;
            in vec2 position;
            out vec2 texcoord;
            uniform float u_zoom;
            uniform vec2 u_pan;
            void main() {
              vec2 uv = vec2(0.5+0.5*position.x, 0.5-0.5*position.y);
              texcoord = (uv - 0.5) / u_zoom + 0.5 + u_pan;
              gl_Position = vec4(position, 0.0, 1.0);
            }`;

function compileShader(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertexShader = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vertexShader, vertexSource);
  gl.compileShader(vertexShader);
  if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(vertexShader)!);
  }

  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fragmentShader, fragmentSource);
  gl.compileShader(fragmentShader);
  if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(fragmentShader);
    if (error) {
      const matches = error.match(/ERROR: 0:(\d+)/);
      if (matches) {
        const lineNum = Number(matches[1]);
        const lines = fragmentSource.split('\n');
        console.error(
          `Error at line ${lineNum}: ${lines[lineNum - 1]}\n${error}`,
        );
      }
      throw new Error(error);
    } else {
      throw new Error('Failed to compile fragment shader.');
    }
  }

  const program = gl.createProgram()!;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program)!);
  }
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  return program;
}

export abstract class BaseWebgl2Renderer implements Renderer {
  protected readonly gl: WebGL2RenderingContext;
  protected readonly program: WebGLProgram;
  private verticesBuffer: WebGLBuffer | null = null;
  private indicesBuffer: WebGLBuffer | null = null;
  protected headroomLog2 = 0;
  protected presentationDisplayPeakLuminance = 400;
  protected readonly framebufferPrimaries = kPrimariesP3;
  protected readonly framebufferTransfer = kTransferSrgb;
  protected tex: WebGLTexture | null = null;
  protected texW = 0;
  protected texH = 0;
  protected fbW = 0;
  protected fbH = 0;
  protected readonly hdr: boolean;
  protected zoom = 1.0;
  protected panX = 0.0;
  protected panY = 0.0;
  protected contentTransfer = 0;
  protected contentPrimaries = 0;

  constructor(
    protected readonly canvas: HTMLCanvasElement,
    fragmentSource: string,
    hdr: boolean,
    protected readonly rendersPicture: boolean, // false if renders curves
  ) {
    this.hdr = hdr;
    this.gl = this.canvas.getContext('webgl2')!;
    this.gl.getExtension('EXT_color_buffer_half_float');
    this.gl.getExtension('EXT_color_buffer_float');
    this.program = this.compileShader(fragmentSource);

    // Can be set to either 'srgb' (default) or 'display-p3'.
    // display-p3 uses the DCI-P3 primaries with a D65 white point and the
    // sRGB transfer function.
    this.gl.drawingBufferColorSpace = 'display-p3';

    if (this.hdr) {
      if (this.canvas.configureHighDynamicRange) {
        this.canvas.configureHighDynamicRange({
          mode: 'extended',
        });
      }
    }
  }

  destroy() {
    // Not mandatory, the context should get garbage collected anyway but
    // this may make it happen more quickly.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }

  setHeadroomLog2(headroomLog2: number, nits: number) {
    this.headroomLog2 = headroomLog2;
    this.presentationDisplayPeakLuminance = nits;
  }

  abstract getVersion(): string;

  protected compileShader(fragmentSource: string) {
    return compileShader(this.gl, vs, fragmentSource);
  }

  isPicture() {
    return this.rendersPicture;
  }
  getCanvas() {
    return this.canvas;
  }

  getImageData(
    scale: number,
    xInDst: number,
    yInDst: number,
    dst: Uint8Array,
    dstStride: number,
  ) {
    const pixels = new Float32Array(this.canvas.width * this.canvas.height * 4);
    this.gl.readPixels(
      0,
      0,
      this.canvas.width,
      this.canvas.height,
      this.gl.RGBA,
      this.gl.FLOAT,
      pixels,
    );
    scale = 255 * scale;
    for (let y = 0; y < this.canvas.height; ++y) {
      for (let x = 0; x < this.canvas.width; ++x) {
        // WebGL renders from bottom to top. Mirror the image vertically.
        const i = ((this.canvas.height - 1 - y) * this.canvas.width + x) * 4;
        const j = (yInDst + y) * dstStride + (xInDst + x) * 4;
        for (let c = 0; c < 3; ++c) {
          const color = Math.round(pixels[i + c] * scale);
          dst[j + c] = Math.max(0, Math.min(color, 255));
        }
        dst[j + 3] = 255;
      }
    }
  }

  setZoomPan(zoom: number, panX: number, panY: number) {
    this.zoom = zoom;
    this.panX = panX;
    this.panY = panY;
  }

  resizeFramebuffer(w: number, h: number) {
    this.fbW = w;
    this.fbH = h;
    const gl = this.gl;
    if (gl) {
      this.canvas.width = this.fbW;
      this.canvas.height = this.fbH;
      if (this.hdr && gl.drawingBufferStorage) {
        gl.drawingBufferStorage(gl.RGBA16F, this.fbW, this.fbH);
      }
      gl.viewport(0, 0, this.fbW, this.fbH);
    }
  }

  setImage(
    imageBitmapSource: HTMLImageElement | HTMLVideoElement,
    image: ImageBitmap | ImageData,
    contentTransfer: number,
    contentPrimaries: number,
  ) {
    this.contentTransfer = contentTransfer;
    this.contentPrimaries = contentPrimaries;
    const gl = this.gl;
    const reallocate = this.texW !== image.width || this.texH !== image.height;
    if (reallocate) {
      if (this.tex) {
        gl.deleteTexture(this.tex);
      }
      this.tex = gl.createTexture()!;
      this.texW = image.width;
      this.texH = image.height;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (reallocate) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16F,
        this.texW,
        this.texH,
        0,
        gl.RGBA,
        gl.FLOAT,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.LINEAR_MIPMAP_NEAREST,
      );
    }
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.texW,
      this.texH,
      gl.RGBA,
      gl.FLOAT,
      image,
    );
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  abstract setUniforms(): void;

  draw() {
    if (!this.gl) {
      return;
    }
    const gl = this.gl;

    if (!this.tex) {
      gl.clearBufferfv(gl.COLOR, 0, [0.5, 0.5, 0.5, 1.0]);
      return;
    }

    gl.useProgram(this.program);

    gl.clearBufferfv(gl.COLOR, 0, [0.5, 0.5, 0.5, 1.0]);

    this.setVerticesIndices(this.program);
    this.setTexture(this.program);
    this.setZoomPanUniforms(this.program);
    this.setUniforms();

    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  protected setVerticesIndices(program: WebGLProgram) {
    const gl = this.gl;
    if (!this.verticesBuffer) {
      this.verticesBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.verticesBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
        gl.STATIC_DRAW,
      );
    }
    if (!this.indicesBuffer) {
      this.indicesBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indicesBuffer);
      gl.bufferData(
        gl.ELEMENT_ARRAY_BUFFER,
        new Uint16Array([0, 1, 2, 0, 2, 3]),
        gl.STATIC_DRAW,
      );
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.verticesBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indicesBuffer);

    const positionLocation = gl.getAttribLocation(program, 'position');
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(positionLocation);
  }

  protected setTexture(program: WebGLProgram) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(gl.getUniformLocation(program, 'content'), 0);
  }

  protected setZoomPanUniforms(program: WebGLProgram) {
    const gl = this.gl;
    gl.uniform1f(gl.getUniformLocation(program, 'u_zoom'), this.zoom);
    gl.uniform2f(gl.getUniformLocation(program, 'u_pan'), this.panX, this.panY);
  }
}

export abstract class Base2dRenderer implements Renderer {
  protected readonly context: CanvasRenderingContext2D;
  protected imageBitmapSource: HTMLImageElement | HTMLVideoElement | null =
    null;
  protected imageBitmap: ImageBitmap | null = null;
  protected headroomLog2 = 0;
  protected presentationDisplayPeakLuminance = 400;
  protected zoom = 1.0;
  protected panX = 0.0;
  protected panY = 0.0;
  protected contentTransfer = 0;
  protected contentPrimaries = 0;

  constructor(
    protected readonly canvas: HTMLCanvasElement,
    protected readonly rendersPicture: boolean,
  ) {
    this.canvas.width = 1500;
    this.canvas.height = 1500;
    this.context = this.canvas.getContext('2d')!;
  }

  destroy() {
    this.canvas.remove();
  }

  setHeadroomLog2(headroomLog2: number, nits: number) {
    this.headroomLog2 = headroomLog2;
    this.presentationDisplayPeakLuminance = nits;
  }

  abstract getVersion(): string;

  isPicture() {
    return this.rendersPicture;
  }

  getCanvas() {
    return this.canvas;
  }

  getImageData(
    scale: number,
    xInDst: number,
    yInDst: number,
    dst: Uint8Array,
    dstStride: number,
  ) {
    const pixels = this.context.getImageData(
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    ).data;

    for (let y = 0; y < this.canvas.height; ++y) {
      for (let x = 0; x < this.canvas.width; ++x) {
        const i = (y * this.canvas.width + x) * 4;
        const j = (yInDst + y) * dstStride + (xInDst + x) * 4;
        for (let c = 0; c < 3; ++c) {
          // Blend on opaque SDR white background.
          const alpha = pixels[i + 3] / 255.0;
          const color = pixels[i + c] * alpha + 255 * (1 - alpha);
          dst[j + c] = Math.max(0, Math.min(Math.round(color * scale), 255));
        }
        // The output is opaque.
        dst[j + 3] = 255;
      }
    }
  }

  setZoomPan(zoom: number, panX: number, panY: number) {
    this.zoom = zoom;
    this.panX = panX;
    this.panY = panY;
  }

  resizeFramebuffer(width: number, height: number, evenIfNotPicture?: boolean) {
    if (this.rendersPicture || evenIfNotPicture === true) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  setImage(
    imageBitmapSource: HTMLImageElement | HTMLVideoElement,
    imageBitmap: ImageBitmap,
    contentTransfer: number,
    contentPrimaries: number,
  ) {
    this.imageBitmapSource = imageBitmapSource;
    this.imageBitmap = imageBitmap;
    this.contentTransfer = contentTransfer;
    this.contentPrimaries = contentPrimaries;
  }

  abstract render(): void;

  draw() {
    this.render();
  }
}

export abstract class Base2dGraphRenderer extends Base2dRenderer {
  protected graphBottomLeft: Point2;
  protected graphTopRight: Point2;
  protected dragViewPoint: Point2 | null = null;
  protected readonly defaultGraphBottomLeft: Point2;
  protected readonly defaultGraphTopRight: Point2;

  constructor(canvas: HTMLCanvasElement) {
    super(canvas, /* rendersPicture= */ false);

    this.defaultGraphBottomLeft = {x: 80, y: this.canvas.height - 100};
    this.defaultGraphTopRight = {x: this.canvas.width - 100, y: 40};
    this.graphBottomLeft = {...this.defaultGraphBottomLeft};
    this.graphTopRight = {...this.defaultGraphTopRight};

    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('mousedown', (e) => {
      this.mouseDown(e);
    });
    this.canvas.addEventListener('mouseup', () => {
      this.mouseUpOrLeave();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.mouseUpOrLeave();
    });
    this.canvas.addEventListener('mousemove', (e) => {
      this.mouseMove(e);
    });
    this.canvas.addEventListener('wheel', (e) => {
      this.wheel(e);
    });
  }

  protected constrainView() {
    const defaultWidth =
      this.defaultGraphTopRight.x - this.defaultGraphBottomLeft.x;
    const currentWidth = this.graphTopRight.x - this.graphBottomLeft.x;

    // Prevent zooming out beyond default size.
    if (currentWidth < defaultWidth) {
      this.graphBottomLeft = {...this.defaultGraphBottomLeft};
      this.graphTopRight = {...this.defaultGraphTopRight};
      return;
    }

    // Prevent panning out of bounds.
    if (this.graphBottomLeft.x > this.defaultGraphBottomLeft.x) {
      const delta = this.graphBottomLeft.x - this.defaultGraphBottomLeft.x;
      this.graphBottomLeft.x -= delta;
      this.graphTopRight.x -= delta;
    }
    if (this.graphTopRight.x < this.defaultGraphTopRight.x) {
      const delta = this.defaultGraphTopRight.x - this.graphTopRight.x;
      this.graphBottomLeft.x += delta;
      this.graphTopRight.x += delta;
    }
    if (this.graphBottomLeft.y < this.defaultGraphBottomLeft.y) {
      const delta = this.defaultGraphBottomLeft.y - this.graphBottomLeft.y;
      this.graphBottomLeft.y += delta;
      this.graphTopRight.y += delta;
    }
    if (this.graphTopRight.y > this.defaultGraphTopRight.y) {
      const delta = this.graphTopRight.y - this.defaultGraphTopRight.y;
      this.graphBottomLeft.y -= delta;
      this.graphTopRight.y -= delta;
    }
  }

  protected getViewPoint(e: MouseEvent): Point2 {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * this.canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * this.canvas.height) / rect.height,
    };
  }

  protected mouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    this.dragViewPoint = this.getViewPoint(e);
  }

  protected mouseUpOrLeave() {
    this.dragViewPoint = null;
  }

  protected mouseMove(e: MouseEvent) {
    if (e.buttons !== 1 || !this.dragViewPoint) {
      return;
    }
    const newViewPoint = this.getViewPoint(e);
    const viewDelta = {
      x: newViewPoint.x - this.dragViewPoint.x,
      y: newViewPoint.y - this.dragViewPoint.y,
    };

    this.graphBottomLeft.x += viewDelta.x;
    this.graphBottomLeft.y += viewDelta.y;
    this.graphTopRight.x += viewDelta.x;
    this.graphTopRight.y += viewDelta.y;

    this.constrainView();

    this.dragViewPoint = newViewPoint;
    this.draw();
  }

  protected wheel(e: WheelEvent) {
    e.preventDefault();
    const viewPoint = this.getViewPoint(e);
    const zoomFactor = Math.exp(-e.deltaY * 0.001);

    const oldWidth = this.graphTopRight.x - this.graphBottomLeft.x;
    const oldHeight = this.graphTopRight.y - this.graphBottomLeft.y;
    const newWidth = oldWidth * zoomFactor;
    const newHeight = oldHeight * zoomFactor;

    const pivotX = (viewPoint.x - this.graphBottomLeft.x) / oldWidth;
    const pivotY = (viewPoint.y - this.graphBottomLeft.y) / oldHeight;

    this.graphBottomLeft.x = viewPoint.x - pivotX * newWidth;
    this.graphBottomLeft.y = viewPoint.y - pivotY * newHeight;
    this.graphTopRight.x = this.graphBottomLeft.x + newWidth;
    this.graphTopRight.y = this.graphBottomLeft.y + newHeight;

    this.constrainView();

    this.draw();
  }
}
