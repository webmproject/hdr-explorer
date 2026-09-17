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

/**
 * Declare interfaces for experimental APIs.
 */

export interface ExperimentalImageDataSettings {
  pixelFormat?: 'uint8' | 'uint16' | 'float16' | 'rgba-float16';
}

export declare interface ScreenDetailed {
  readonly highDynamicRangeHeadroom: number;
}

export declare interface ScreenDetails {
  readonly currentScreen: ScreenDetailed;
  addEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => void;
}

export declare interface CanvasHighDynamicRangeOptions {
  mode: 'default' | 'extended';
  agtm?: string; // AGTM JSON
}

declare global {
  interface Window {
    // Experimental/limited availability API.
    // Assume that the user is using Chrome and this is available (otherwise
    // it should be marked possibly undefined with '?').
    getScreenDetails: () => Promise<ScreenDetails>;
  }

  interface HTMLCanvasElement {
    // Only available when the "Experimental Web Platform Features" flag is
    // enabled in chrome://flags.
    configureHighDynamicRange?: (
      options: CanvasHighDynamicRangeOptions,
    ) => void;
  }

  interface WebGL2RenderingContext {
    drawingBufferStorage?: (
      format: number,
      width: number,
      height: number,
    ) => void;
  }
}
