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

import {DataStream} from './bitstream';
import {Av1CBox, GenericBox, HvcCBox, VisualSampleEntryBox} from './isobmff';
import {Track} from './media_parser';

/** Reverses the bit order of a 32-bit unsigned integer. */
export function reverseBits32(value: number): number {
  let n = value >>> 0;
  n = ((n >>> 1) & 0x55555555) | ((n & 0x55555555) << 1);
  n = ((n >>> 2) & 0x33333333) | ((n & 0x33333333) << 2);
  n = ((n >>> 4) & 0x0f0f0f0f) | ((n & 0x0f0f0f0f) << 4);
  n = ((n >>> 8) & 0x00ff00ff) | ((n & 0x00ff00ff) << 8);
  return ((n >>> 16) | (n << 16)) >>> 0;
}

/**
 * Formats an HEVC codec string from hvcC box parameters (ISO/IEC 14496-15 Annex E.3).
 * Example output: 'hvc1.1.6.L93.B0' or 'hvc1.2.4.L153.B0'.
 */
export function buildHevcCodecString(hvcC: HvcCBox): string {
  const spaceLetter = ' ABC'[hvcC.generalProfileSpace] ?? '';
  const profileId = `${spaceLetter.trim()}${hvcC.generalProfileIdc}`;
  const compatHex = reverseBits32(hvcC.generalProfileCompatibilityFlags)
    .toString(16)
    .toUpperCase();
  const tierAndLevel = `${hvcC.generalTierFlag ? 'H' : 'L'}${hvcC.generalLevelIdc}`;

  const parts = ['hvc1', profileId, compatHex, tierAndLevel];

  // Trim trailing zeros from the constraint flags.
  const flags = [...hvcC.generalConstraintIndicatorFlags];
  while (flags.length > 0 && flags[flags.length - 1] === 0) {
    flags.pop();
  }
  for (const byte of flags) {
    parts.push(byte.toString(16).padStart(2, '0').toUpperCase());
  }

  return parts.join('.');
}

/**
 * Builds an AV1 codec string from an Av1CBox per the AV1 Codec Registration.
 * Example output: 'av01.0.08M.10'.
 */
export function buildAv1CodecString(av1C: Av1CBox): string {
  const profile = av1C.seqProfile;
  const level = av1C.seqLevelIdx0.toString().padStart(2, '0');
  const tier = av1C.seqTier0 === 1 ? 'H' : 'M';
  let bitDepth = 8;
  if (av1C.highBitdepth) {
    bitDepth = av1C.twelveBit ? 12 : 10;
  }
  const bitDepthStr = bitDepth.toString().padStart(2, '0');
  return `av01.${profile}.${level}${tier}.${bitDepthStr}`;
}

function serializeBoxContent(box: Av1CBox | HvcCBox): ArrayBuffer {
  box.updateSize();
  const contentSize = box.getContentSize();
  const buffer = new ArrayBuffer(contentSize);
  const stream = new DataStream(new DataView(buffer));
  box.writeContent(stream);
  return buffer;
}

/**
 * Inspects a demuxed track and returns a VideoDecoderConfig supported by the browser,
 * or null if unsupported.
 */
async function getVideoDecoderConfig(
  videoTrack: Track,
): Promise<VideoDecoderConfig | null> {
  if (
    typeof VideoDecoder === 'undefined' ||
    typeof VideoDecoder.isConfigSupported !== 'function'
  ) {
    return null;
  }

  const visualEntry = videoTrack.box?.getDescendant(
    videoTrack.codec,
    VisualSampleEntryBox,
  );
  const codedWidth = visualEntry?.width;
  const codedHeight = visualEntry?.height;

  let config: VideoDecoderConfig | null = null;

  if (videoTrack.codec === 'av01') {
    const av1C = videoTrack.box?.getDescendant('av1C', Av1CBox);
    let codec = 'av01.0.08M.10';
    let description: ArrayBuffer | undefined;
    if (av1C) {
      codec = buildAv1CodecString(av1C);
      description = serializeBoxContent(av1C);
    }
    config = {
      codec,
      ...(description ? {description} : {}),
      ...(codedWidth ? {codedWidth, codedHeight} : {}),
    };
  } else if (videoTrack.codec === 'hvc1' || videoTrack.codec === 'hev1') {
    const hvcC = videoTrack.box?.getDescendant('hvcC', HvcCBox);
    if (hvcC) {
      const codec = buildHevcCodecString(hvcC);
      const description = serializeBoxContent(hvcC);
      config = {
        codec,
        description,
        ...(codedWidth ? {codedWidth, codedHeight} : {}),
      };
    } else {
      config = {
        codec: 'hvc1.1.6.L93.B0',
        ...(codedWidth ? {codedWidth, codedHeight} : {}),
      };
    }
  } else if (videoTrack.codec === 'avc1') {
    const avcC = videoTrack.box?.getDescendant('avcC', GenericBox);
    if (avcC && avcC.data.length >= 4) {
      const p1 = avcC.data[1].toString(16).padStart(2, '0');
      const p2 = avcC.data[2].toString(16).padStart(2, '0');
      const p3 = avcC.data[3].toString(16).padStart(2, '0');
      const codec = `avc1.${p1}${p2}${p3}`;
      const description = avcC.data.buffer.slice(
        avcC.data.byteOffset,
        avcC.data.byteOffset + avcC.data.byteLength,
      );
      config = {
        codec,
        description,
        ...(codedWidth ? {codedWidth, codedHeight} : {}),
      };
    }
  } else if (videoTrack.codec === 'vp09') {
    const vpcC = videoTrack.box?.getDescendant('vpcC', GenericBox);
    if (vpcC && vpcC.data.length >= 4) {
      const profile = vpcC.data[1].toString().padStart(2, '0');
      const level = vpcC.data[2].toString().padStart(2, '0');
      const bitDepth = (vpcC.data[3] >> 4).toString().padStart(2, '0');
      const codec = `vp09.${profile}.${level}.${bitDepth}`;
      config = {
        codec,
        ...(codedWidth ? {codedWidth, codedHeight} : {}),
      };
    } else {
      config = {
        codec: 'vp09.02.10.10',
        ...(codedWidth ? {codedWidth, codedHeight} : {}),
      };
    }
  }

  if (!config) {
    return null;
  }

  try {
    const support = await VideoDecoder.isConfigSupported(config);
    if (support.supported) {
      return config;
    }
    if (config.codec.startsWith('hvc1.')) {
      const alt = {...config, codec: config.codec.replace(/^hvc1\./, 'hev1.')};
      const altSupport = await VideoDecoder.isConfigSupported(alt);
      if (altSupport.supported) {
        return alt;
      }
    } else if (config.codec.startsWith('hev1.')) {
      const alt = {...config, codec: config.codec.replace(/^hev1\./, 'hvc1.')};
      const altSupport = await VideoDecoder.isConfigSupported(alt);
      if (altSupport.supported) {
        return alt;
      }
    }
    console.warn('WebCodecs VideoDecoder does not support config:', config);
    return null;
  } catch (e) {
    console.warn('VideoDecoder.isConfigSupported error:', e);
    return null;
  }
}

export interface WebCodecsDecodeOptions {
  framesToProcess: number;
  abortSignal: AbortSignal;
  onFrame: (frame: VideoFrame, index: number, timeSec: number) => Promise<void>;
  onProgress?: (frameIndex: number, totalFrames: number) => void;
  pauseCheck?: () => Promise<void>;
}

/**
 * Decodes frames from a video track sequentially using WebCodecs VideoDecoder.
 * Returns true if decoding completed, or false if WebCodecs is unsupported or cancelled.
 * Throws on decode error so caller can fall back to alternative decoding methods.
 */
export async function decodeTrackWithWebCodecs(
  videoTrack: Track,
  options: WebCodecsDecodeOptions,
): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined' || !videoTrack.samples.length) {
    return false;
  }

  const config = await getVideoDecoderConfig(videoTrack);
  if (!config) {
    return false;
  }

  const {framesToProcess, abortSignal, onFrame, onProgress, pauseCheck} =
    options;
  if (framesToProcess <= 0) {
    return true;
  }

  const outputQueue: VideoFrame[] = [];
  const decoderState = {error: null as Error | null};
  let isFlushed = false;
  let isDecoderClosed = false;
  let notifyOutput: (() => void) | null = null;
  let notifyDrain: (() => void) | null = null;

  const wakeOutput = () => {
    const fn = notifyOutput;
    notifyOutput = null;
    fn?.();
  };

  const wakeDrain = () => {
    const fn = notifyDrain;
    notifyDrain = null;
    fn?.();
  };

  const closeDecoder = () => {
    if (!isDecoderClosed) {
      isDecoderClosed = true;
      try {
        decoder.close();
      } catch {}
    }
  };

  const decoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
      if (frame.timestamp < 0) {
        frame.close();
        return;
      }
      outputQueue.push(frame);
      wakeOutput();
    },
    error: (err: DOMException) => {
      decoderState.error = new Error(`${err.name}: ${err.message}`);
      wakeOutput();
      wakeDrain();
    },
  });

  decoder.configure(config);

  const feedPromise = (async () => {
    try {
      for (let sIdx = 0; sIdx < videoTrack.samples.length; sIdx++) {
        if (isDecoderClosed || abortSignal.aborted || decoderState.error) {
          break;
        }
        while (
          (decoder.decodeQueueSize >= 4 || outputQueue.length >= 4) &&
          !isDecoderClosed &&
          !abortSignal.aborted &&
          !decoderState.error
        ) {
          await new Promise<void>((resolve) => {
            notifyDrain = resolve;
            decoder.ondequeue = () => {
              wakeDrain();
            };
          });
        }
        if (isDecoderClosed || abortSignal.aborted || decoderState.error) {
          break;
        }

        const sample = videoTrack.samples[sIdx];
        if (!sample.data || sample.data.length === 0) {
          continue;
        }
        const isKey = sample.isSync || sIdx === 0;
        const timeSec =
          typeof sample.presentationTimeSec === 'number' &&
          !isNaN(sample.presentationTimeSec)
            ? sample.presentationTimeSec
            : sample.cts / videoTrack.timescale;
        const timestampUs = Math.round(timeSec * 1_000_000);
        const durationSec =
          typeof sample.presentationDurationSec === 'number' &&
          !isNaN(sample.presentationDurationSec)
            ? sample.presentationDurationSec
            : sample.duration / videoTrack.timescale;
        const durationUs = Math.max(0, Math.round(durationSec * 1_000_000));

        const chunk = new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: timestampUs,
          duration: durationUs,
          data: sample.data,
        });
        decoder.decode(chunk);
      }

      if (!isDecoderClosed && !abortSignal.aborted && !decoderState.error) {
        await decoder.flush();
      }
    } catch (e) {
      if (!isDecoderClosed && !abortSignal.aborted) {
        decoderState.error = e instanceof Error ? e : new Error(String(e));
      }
    } finally {
      isFlushed = true;
      wakeOutput();
      wakeDrain();
    }
  })();

  try {
    for (let i = 0; i < framesToProcess; i++) {
      if (pauseCheck) {
        await pauseCheck();
      }
      if (abortSignal.aborted) {
        return false;
      }
      if (onProgress) {
        onProgress(i, framesToProcess);
      }

      while (outputQueue.length === 0 && !isFlushed && !decoderState.error) {
        await new Promise<void>((resolve) => {
          notifyOutput = resolve;
        });
      }

      if (decoderState.error) {
        throw decoderState.error;
      }

      if (outputQueue.length === 0) {
        break;
      }

      const videoFrame = outputQueue.shift()!;
      wakeDrain();

      const sample = videoTrack.samplesSortedByPresentationTime[i];
      const time =
        sample?.presentationTimeSec ?? videoFrame.timestamp / 1_000_000;

      try {
        await onFrame(videoFrame, i, time);
      } finally {
        videoFrame.close();
      }
    }
    return true;
  } finally {
    closeDecoder();
    for (const f of outputQueue) {
      try {
        f.close();
      } catch {}
    }
    outputQueue.length = 0;
    wakeDrain();
    await feedPromise;
  }
}
