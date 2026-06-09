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

import {AgtmMetadata} from './color_helpers/agtm';
import {
  getChromaticities,
  kPrimariesP3,
  kPrimariesRec2020,
  kPrimariesSRGB,
} from './color_helpers/color_functions';
import {clamp} from './color_helpers/math_helpers';
import {
  Co64Box,
  DinfBox,
  DrefBox,
  HdlrBox,
  It35SampleEntryBox,
  MdatBox,
  MdhdBox,
  MdiaBox,
  MinfBox,
  MoovBox,
  StblBox,
  StcoBox,
  StscBox,
  StsdBox,
  StszBox,
  SttsBox,
  TkhdBox,
  TrackReferenceTypeBox,
  TrakBox,
  TrefBox,
  UrlBox,
  findBox,
  writeIsobmff,
} from './isobmff';
import {ByteWriter} from './bitstream';
import {Chunk, Sample, parseMp4, removeTrack} from './media_parser';

// Everything in ISOBMFF and SMPTE 2094-50 is big endian.
const ENDIANNESS = false; // big-endian

function writeScaledU16(
  dataView: DataView,
  offset: number,
  value: number,
  scale = 1,
  shift = 0,
  min = 0,
  max = 65535,
) {
  dataView.setUint16(
    offset,
    clamp(Math.round(value * scale) + shift, min, max),
    ENDIANNESS,
  );
}

function haveCommonMixParams(altr: AgtmMetadata['altr']): boolean {
  if (altr.length <= 1) {
    return true;
  }
  const firstMix = altr[0].mix;
  return altr
    .slice(1)
    .every(
      (a) =>
        a.mix.rgb[0] === firstMix.rgb[0] &&
        a.mix.rgb[1] === firstMix.rgb[1] &&
        a.mix.rgb[2] === firstMix.rgb[2] &&
        a.mix.max === firstMix.max &&
        a.mix.min === firstMix.min &&
        a.mix.channel === firstMix.channel,
    );
}

function getGainApplicationChromaticitiesMode(
  primaries: number | undefined,
  c: number[] | undefined,
): number {
  if (primaries !== undefined) {
    if (primaries === kPrimariesRec2020) return 2;
    if (primaries === kPrimariesP3) return 1;
    if (primaries === kPrimariesSRGB) return 0;
    return 3;
  }
  if (!c) return 2; // Default to Rec.2020 if absolutely nothing is specified (shouldn't happen with valid metadata)

  function match(c1: number[], c2: number[]) {
    return c1.every((v, i) => Math.abs(v - c2[i]) < 1e-4);
  }
  if (match(c, getChromaticities(kPrimariesRec2020))) return 2;
  if (match(c, getChromaticities(kPrimariesP3))) return 1;
  if (match(c, getChromaticities(kPrimariesSRGB))) return 0;
  return 3;
}

function haveCommonCurveParams(altr: AgtmMetadata['altr']): boolean {
  if (altr.length <= 1) {
    return true;
  }
  const firstCurve = altr[0].curve;
  return altr
    .slice(1)
    .every(
      (a) =>
        a.curve.length === firstCurve.length &&
        a.curve.every((p, j) => p.x === firstCurve[j].x),
    );
}

export function makeAgtmPayload(m: AgtmMetadata): Uint8Array {
  // Calculate the maximum possible size for the AGTM payload to pre-allocate
  // a buffer. This assumes worst-case scenarios for all conditional fields.
  const MAX_AGTM_SIZE_BYTES =
    1 /* application_version + minimum_application_version + reserved(2) */ +
    // smpte_st_2094_50_color_volume_transform
    (1 /* flags */ + 2) /* custom_hdr_reference_white */ +
    // smpte_st_2094_50_adaptive_tone_map
    2 /* baseline_hdr_headroom */ +
    1 /* num_alternate_images and flags */ +
    8 * 2 /* gain_application_space_chromaticities */ +
    4 * // max num_altr
      (2 /* alternate_hdr_headrooms */ +
        // smpte_st_2094_50_component_mixing
        (1 /* type and flags */ + 6 * 2) /* coeffs */ +
        // smpte_st_2094_50_gain_curve
        (1 /* num_points and flags */ +
          32 * // max num_points
            (2 /* x */ + 2 /* y */ + 2))); /* m */

  const buffer = new ArrayBuffer(MAX_AGTM_SIZE_BYTES);
  const dataView = new DataView(buffer);
  let offset = 0;

  const AGTM_APPLICATION_VERSION = 0;
  const AGTM_MINIMUM_APPLICATION_VERSION = 0;
  dataView.setUint8(
    offset++,
    new ByteWriter()
      .addBits(AGTM_APPLICATION_VERSION, 3)
      .addBits(AGTM_MINIMUM_APPLICATION_VERSION, 3)
      .addBits(0 /*reserved_zero*/, 2).value,
  );

  const hasCustomHdrReferenceWhiteFlag = m.hdr_reference_white !== 203;
  const hasAdaptiveToneMapFlag = true;
  dataView.setUint8(
    offset++,
    new ByteWriter()
      .addBit(hasCustomHdrReferenceWhiteFlag)
      .addBit(hasAdaptiveToneMapFlag)
      .addBits(0 /*reserved_zero*/, 6).value,
  );
  if (hasCustomHdrReferenceWhiteFlag) {
    writeScaledU16(dataView, offset, m.hdr_reference_white, 5);
    offset += 2;
  }

  // smpte_st_2094_50_adaptive_tone_map
  writeScaledU16(dataView, offset, m.baseline_hdr_headroom, 10000);
  offset += 2;

  const numAltr = Math.min(m.altr.length, 4);
  const gainApplicationChromaticitiesMode =
    getGainApplicationChromaticitiesMode(
      m.gain_application_space_primaries,
      m.gain_application_space_chromaticities,
    );
  const hasCommonMixParamsFlag = haveCommonMixParams(m.altr);
  const hasCommonCurveParamsFlag = haveCommonCurveParams(m.altr);
  dataView.setUint8(
    offset++,
    new ByteWriter()
      .addBit(false /*use_reference_white_tone_mapping*/)
      .addBits(numAltr, 3)
      .addBits(gainApplicationChromaticitiesMode, 2)
      .addBit(hasCommonMixParamsFlag)
      .addBit(hasCommonCurveParamsFlag).value,
  );

  if (gainApplicationChromaticitiesMode === 3) {
    const customChromaticities =
      m.gain_application_space_chromaticities ??
      getChromaticities(
        m.gain_application_space_primaries ?? kPrimariesRec2020,
      );
    for (let i = 0; i < 8; ++i) {
      const c = customChromaticities[i];
      writeScaledU16(dataView, offset, c, 50000, 0, 0, 50000);
      offset += 2;
    }
  }

  for (let i = 0; i < numAltr; ++i) {
    const altr = m.altr[i];
    writeScaledU16(dataView, offset, altr.headroom, 10000);
    offset += 2;

    const curveLength = Math.min(altr.curve.length, 32);
    if (i === 0 || !hasCommonMixParamsFlag) {
      const componentMixingType = 3; // All coeffs written
      const coeffs = [
        altr.mix.rgb[0],
        altr.mix.rgb[1],
        altr.mix.rgb[2],
        altr.mix.max,
        altr.mix.min,
        altr.mix.channel,
      ].map((c) => Math.max(c, 0));
      // Coeffs should sum to 1 in theory, normalize them just in case.
      const coeffsSum = coeffs.reduce((a, b) => a + b, 0);
      const normalizedCoeffs =
        coeffsSum !== 0 ? coeffs.map((c) => c / coeffsSum) : [0, 0, 0, 1, 0, 0];
      // Scale coeffs for serialization.
      const kCoeffScale = 50000;
      const scaledCoeffs = normalizedCoeffs.map((c) =>
        Math.round(c * kCoeffScale),
      );
      const scaledCoeffsSum = scaledCoeffs.reduce((a, b) => a + b, 0);
      let delta = kCoeffScale - scaledCoeffsSum;
      // Make sure the encoded coeffs sum to kCoeffScale exactly.
      if (delta !== 0) {
        for (let j = 0; j < scaledCoeffs.length; j++) {
          if (scaledCoeffs[j] !== 0) {
            const shift = delta > 0 ? delta : Math.max(delta, -scaledCoeffs[j]);
            scaledCoeffs[j] += shift;
            delta -= shift;
          }
          if (delta === 0) break;
        }
      }
      const writer = new ByteWriter().addBits(componentMixingType, 2);
      for (let c = 0; c < 6; ++c) {
        writer.addBit(scaledCoeffs[c] !== 0);
      }
      dataView.setUint8(offset++, writer.value);

      for (let c = 0; c < 6; ++c) {
        if (scaledCoeffs[c] !== 0) {
          dataView.setUint16(offset, scaledCoeffs[c], ENDIANNESS);
          offset += 2;
        }
      }
    }

    const usePchipSlope = false;
    if (i === 0 || !hasCommonCurveParamsFlag) {
      dataView.setUint8(
        offset++,
        new ByteWriter()
          .addBits(curveLength - 1, 5)
          .addBit(usePchipSlope)
          .addBits(0 /*reserved_zero*/, 2).value,
      );

      for (let j = 0; j < curveLength; ++j) {
        writeScaledU16(dataView, offset, altr.curve[j].x, 1000);
        offset += 2;
      }
    }

    const expectedYSign = m.baseline_hdr_headroom < altr.headroom ? 1 : -1;
    for (let j = 0; j < curveLength; ++j) {
      const ySign = Math.sign(altr.curve[j].y);
      if (ySign !== expectedYSign && Math.abs(altr.curve[j].y) > 1e-6) {
        console.warn(
          `Sign of y does not match expected sign ${expectedYSign} based on altr headroom ${altr.headroom} and baseline headroom ${m.baseline_hdr_headroom} for altr index ${i}, point (x=${altr.curve[j].x}, y=${altr.curve[j].y})`,
        );
      }
      const absVal = Math.abs(altr.curve[j].y);
      writeScaledU16(dataView, offset, absVal, 10000, 0, 0, 60000);
      offset += 2;
    }

    if (!usePchipSlope) {
      for (let j = 0; j < curveLength; ++j) {
        const m = altr.curve[j].m ?? 0;
        const theta = Math.atan(m);
        writeScaledU16(dataView, offset, theta, 36000 / Math.PI, 18000);
        offset += 2;
      }
    }
  }

  return new Uint8Array(buffer).subarray(0, offset);
}

function makeT35Identifier(): Uint8Array {
  // The T35 payload has a size of 5 bytes:
  // - itu_t_t35_country_code (1)
  // - itu_t_t35_terminal_provider_code (2)
  // - itu_t_t35_terminal_provider_oriented_code (2)
  const t35Payload = new Uint8Array(5);
  const t35DataView = new DataView(t35Payload.buffer);
  let offset = 0;
  // country_code = 0xB5 (USA)
  t35DataView.setUint8(offset++, 0xb5);
  // terminal_provider_code = 0x0090 (SMPTE)
  t35DataView.setUint16(offset, 0x0090, ENDIANNESS);
  offset += 2;
  // terminal_provider_oriented_code = 0x0001 (AGTM)
  t35DataView.setUint16(offset, 0x0001, ENDIANNESS);
  offset += 2;
  return t35Payload;
}

/**
 * Takes in an AV1 MP4 file and injects the given AGTM metadata into it.
 * @param source The source MP4 file as an ArrayBuffer.
 * @param metadataList The list of AGTM metadata to inject. The index in the
 *     list corresponds to the index of the frame that the metadata should
 *     be associated with.
 * @returns The modified MP4 file as an ArrayBuffer or null in case of error.
 */
export function muxAgtmMetadata(
  source: ArrayBuffer,
  metadataList: Array<AgtmMetadata | null>,
): ArrayBuffer | null {
  const mp4 = parseMp4(source);
  if (!mp4) {
    console.error('Error parsing MP4');
    return null;
  }

  // Remove existing AGTM tracks.
  const tracksToRemove = new Set<number>();
  for (const trackId in mp4.hdrMetadata) {
    const trackIdNum = Number(trackId);
    if (mp4.hdrMetadata[trackIdNum]['AGTM']) {
      tracksToRemove.add(mp4.hdrMetadata[trackIdNum]['AGTM'].sourceTrackId);
    }
  }
  for (const trackId of tracksToRemove) {
    removeTrack(mp4, trackId);
  }

  const moovBox = findBox(mp4.boxes, 'moov', MoovBox);
  const mdatBox = findBox(mp4.boxes, 'mdat', MdatBox);
  if (!moovBox || !mdatBox) {
    console.error('No moov or mdat box found');
    return null;
  }
  const videoTrack = Object.values(mp4.tracks).find(
    (track) => track.handlerType === 'vide',
  );
  if (!videoTrack) {
    console.error('No video track found');
    return null;
  }

  const videoTrackMdhdBox = videoTrack.box?.getDescendant('mdhd', MdhdBox);
  const videoTrackTkhdBox = videoTrack.box?.getDescendant('tkhd', TkhdBox);
  if (!videoTrackMdhdBox || !videoTrackTkhdBox) {
    console.error('No mdhd or tkhd box found for video track');
    return null;
  }

  // Create the AGTM track boxes.
  const trakBox = new TrakBox('trak');
  moovBox.children.push(trakBox);

  const tkhdBox = new TkhdBox('tkhd');
  trakBox.children.push(tkhdBox);
  const maxExistingTrackId = Object.values(mp4.tracks).reduce(
    (maxTrackId, track) => Math.max(maxTrackId, track.id),
    0,
  );
  const agtmTrackId = maxExistingTrackId + 1;
  tkhdBox.trackId = agtmTrackId;
  tkhdBox.duration = videoTrackTkhdBox.duration;
  const now = new Date().toISOString();
  tkhdBox.creationTime = now;
  tkhdBox.modificationTime = now;

  const trefBox = new TrefBox('tref');
  trakBox.children.push(trefBox);
  const rndrBox = new TrackReferenceTypeBox('rndr');
  trefBox.children.push(rndrBox);
  rndrBox.trackIds = [videoTrack.id];

  const mdiaBox = new MdiaBox('mdia');
  trakBox.children.push(mdiaBox);

  const mdhdBox = new MdhdBox('mdhd');
  mdiaBox.children.push(mdhdBox);
  mdhdBox.timescale = videoTrackMdhdBox.timescale;
  mdhdBox.duration = videoTrackMdhdBox.duration;
  mdhdBox.creationTime = now;
  mdhdBox.modificationTime = now;

  const hdlrBox = new HdlrBox('hdlr');
  mdiaBox.children.push(hdlrBox);
  hdlrBox.handlerType = 'meta';

  const minfBox = new MinfBox('minf');
  mdiaBox.children.push(minfBox);

  const dinfBox = new DinfBox('dinf');
  minfBox.children.push(dinfBox);
  const drefBox = new DrefBox('dref');
  dinfBox.children.push(drefBox);
  const urlBox = new UrlBox('url ');
  urlBox.flags = 1;  // Data is in the same file
  drefBox.children.push(urlBox);

  const stblBox = new StblBox('stbl');
  minfBox.children.push(stblBox);

  const stsdBox = new StsdBox('stsd');
  stblBox.children.push(stsdBox);
  const it35Box = new It35SampleEntryBox('it35');
  stsdBox.children.push(it35Box);
  it35Box.dataReferenceIndex = 1;
  // AGTM metadata.
  it35Box.t35Identifier = makeT35Identifier();

  const sttsBox = new SttsBox('stts'); // Time to sample box
  stblBox.children.push(sttsBox);
  const stscBox = new StscBox('stsc'); // Sample to chunk box
  stblBox.children.push(stscBox);
  const stcoBox = new StcoBox('stco'); // Chunk offset box
  stblBox.children.push(stcoBox);
  const stszBox = new StszBox('stsz'); // Sample size box
  stblBox.children.push(stszBox);

  // Create the AGTM samples.
  const agtmSamples: Sample[] = [];
  const numVideoSamples = videoTrack.samplesSortedByPresentationTime.length;
  // Index of the AGTM sample corresponding to each video sample (in presentation order).
  const sampleIdxToMetadataIdx = new Array(numVideoSamples);
  let metadataIdx = -1;
  // Pad the metadata list with null values for samples that don't have
  // metadata.
  const paddedMetadataList = [...metadataList];
  for (let i = paddedMetadataList.length; i < numVideoSamples; ++i) {
    paddedMetadataList[i] = null;
  }
  for (let i = 0; i < paddedMetadataList.length; ++i) {
    const metadata = paddedMetadataList[i];
    if (metadata === null) {
      sampleIdxToMetadataIdx[i] = metadataIdx;
      continue;
    }
    metadataIdx++;
    sampleIdxToMetadataIdx[i] = metadataIdx;
    const sampleStartCts = videoTrack.samplesSortedByPresentationTime[i].cts;
    const samplePresentationTimeSec =
      videoTrack.samplesSortedByPresentationTime[i].presentationTimeSec;
    while (
      i + 1 < paddedMetadataList.length &&
      paddedMetadataList[i + 1] === null
    ) {
      i++;
      sampleIdxToMetadataIdx[i] = metadataIdx;
    }
    const sampleEnd =
      videoTrack.samplesSortedByPresentationTime[i].cts +
      videoTrack.samplesSortedByPresentationTime[i].duration;
    const sampleDuration = sampleEnd - sampleStartCts;
    const payload = makeAgtmPayload(metadata);
    const sampleSize = payload.length;
    stszBox.sampleCount++;
    stszBox.sampleSizes.push(sampleSize);

    const agtmSampleIdx = agtmSamples.length;
    const agtmSample: Sample = {
      id: agtmSampleIdx,
      trackId: agtmTrackId,
      offset: 0,
      size: sampleSize,
      data: payload,
      dts: sampleStartCts,
      duration: sampleDuration,
      cts: sampleStartCts,
      presentationTimeSec: samplePresentationTimeSec,
      presentationDurationSec:
        videoTrack.samplesSortedByPresentationTime[i].presentationTimeSec +
        videoTrack.samplesSortedByPresentationTime[i].presentationDurationSec -
        samplePresentationTimeSec,
      isSync: false,
    };
    agtmSamples.push(agtmSample);
  }
  mp4.samples.push(...agtmSamples);

  // Update stts box (time to sample box).
  let currentDuration = -1;
  for (let i = 0; i < agtmSamples.length; ++i) {
    const duration = agtmSamples[i].duration;
    if (duration === currentDuration) {
      sttsBox.entries[sttsBox.entries.length - 1].sampleCount++;
    } else {
      sttsBox.entries.push({
        sampleCount: 1,
        sampleDelta: duration,
      });
      currentDuration = duration;
    }
  }

  // Create the AGTM chunks.
  const agtmChunks: Chunk[] = [];
  // Map from DTS index to CTS index for video samples.
  const dtsIdxToCtsIdx = new Array(videoTrack.samples.length);
  for (let i = 0; i < videoTrack.samplesSortedByPresentationTime.length; ++i) {
    dtsIdxToCtsIdx[videoTrack.samplesSortedByPresentationTime[i].id] = i;
  }
  let alreadyWrittenAgtmSampleIdx = -1;
  for (const chunk of videoTrack.chunks) {
    const videoSamples = videoTrack.samples.slice(
      chunk.firstSample,
      chunk.firstSample + chunk.sampleCount,
    );
    const videoSamplesCtsIdx = videoSamples.map(
      (sample) => dtsIdxToCtsIdx[sample.id],
    );
    const agtmSampleIdxs = videoSamplesCtsIdx.map(
      (ctsIdx) => sampleIdxToMetadataIdx[ctsIdx],
    );
    const maxAgtmSampleIdx = Math.max(...agtmSampleIdxs);
    if (maxAgtmSampleIdx <= alreadyWrittenAgtmSampleIdx) {
      continue;
    }
    const agtmIdxStart = alreadyWrittenAgtmSampleIdx + 1;
    const agtmIdxEnd = maxAgtmSampleIdx;
    alreadyWrittenAgtmSampleIdx = agtmIdxEnd;
    const sampleCount = agtmIdxEnd - agtmIdxStart + 1;

    const agtmChunk: Chunk = {
      trackId: agtmTrackId,
      offset: 0, // Will be updated later.
      firstSample: agtmIdxStart,
      sampleCount,
      firstSampleDts: agtmSamples[agtmIdxStart].dts,
    };
    agtmChunks.push(agtmChunk);
    // The value will be updated later but it's important to have a placeholder
    // so that the box size can be computed correctly.
    stcoBox.chunkOffsets.push(0);
  }
  mp4.tracks[agtmTrackId] = {
    id: agtmTrackId,
    samples: agtmSamples,
    samplesSortedByPresentationTime: agtmSamples,
    chunks: agtmChunks,
    codec: 'it35',
    handlerType: 'meta',
    timescale: mdhdBox.timescale,
    box: trakBox,
  };

  // Fill stscBox (Sample to Chunk Box) for the AGTM track.
  let currentSamplesPerChunk = -1;
  for (let i = 0; i < agtmChunks.length; ++i) {
    const chunk = agtmChunks[i];
    const samplesPerChunk = chunk.sampleCount;
    const chunkIndex = i + 1; // stsc uses 1-based indexing for firstChunk
    if (
      samplesPerChunk === currentSamplesPerChunk &&
      stscBox.entries.length > 0
    ) {
      // This chunk has the same properties as the previous one,
      // so it's part of the current run. No need to add a new entry.
    } else {
      // Start a new run in stscBox.
      stscBox.entries.push({
        firstChunk: chunkIndex,
        samplesPerChunk,
        sampleDescriptionIndex: 1,
      });
      currentSamplesPerChunk = samplesPerChunk;
    }
  }

  const sampleSizesSum = mp4.samples.reduce((a, b) => a + b.data.length, 0);
  const mdatHeaderSize = sampleSizesSum + 8 >= 0xffffffff ? 16 : 8;

  const newMdatData = new Uint8Array(sampleSizesSum);
  mdatBox.data = newMdatData;
  mdatBox.updateSize(); // Updates mdatBox.size based on new data and header size.

  // Now that all the boxes have been created and populated, compute the new
  // start offset of the mdat box (in case it's after the moov box).
  moovBox.updateSize();
  let mdatStart = 0;
  for (const box of mp4.boxes) {
    if (box === mdatBox) {
      break;
    }
    mdatStart += box.size;
  }

  // Create the new mdat data by interleaving the chunks from all tracks.
  const allChunks: Chunk[] = Object.values(mp4.tracks).reduce(
    (a, b) => a.concat(b.chunks),
    [] as Chunk[],
  );
  allChunks.sort((a, b) => a.firstSampleDts - b.firstSampleDts);

  let offsetInMdatData = 0;
  for (const chunk of allChunks) {
    const offsetInFile = mdatStart + mdatHeaderSize + offsetInMdatData;
    chunk.offset = offsetInFile;
    for (
      let i = chunk.firstSample;
      i < chunk.firstSample + chunk.sampleCount;
      ++i
    ) {
      const track = mp4.tracks[chunk.trackId];
      if (!track) {
        console.error('Internal error: no track found for chunk');
        return null;
      }
      const sample = track.samples[i];
      newMdatData.set(sample.data, offsetInMdatData);
      offsetInMdatData += sample.data.length;
    }
  }

  // Update chunk offset boxes based on new offsets in allChunks.
  for (const track of Object.values(mp4.tracks)) {
    const trackStblBox = track.box?.getDescendant('stbl', StblBox);
    if (!trackStblBox) continue;
    const trackStcoBox =
      trackStblBox.getDescendant('stco', StcoBox) ??
      trackStblBox.getDescendant('co64', Co64Box);
    if (!trackStcoBox) continue;

    const trackChunks = allChunks.filter((chunk) => chunk.trackId === track.id);
    if (trackChunks.length !== trackStcoBox.chunkOffsets.length) {
      // stco box should have been populated with placeholders earlier.
      console.error(
        'Internal error: number of chunks does not match number of chunk offsets',
      );
      return null;
    }
    trackStcoBox.chunkOffsets = trackChunks.map((chunk) => chunk.offset);
  }

  return writeIsobmff(mp4.boxes);
}
