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

import {AgtmMetadata, Altr, ComponentMix, Point2} from './color_helpers/agtm';
import {parseAgtm} from './agtm_parser';
import {Bitstream} from './bitstream';
import {Hdr10pMetadata, Hdr10pWindow} from './color_helpers/hdr10p';
import {clamp} from './color_helpers/math_helpers';
import {pchipInterpolationSlopes} from './color_helpers/pchip';
import {
  Box,
  Co64Box,
  ColrBox,
  ContainerBox,
  ContainerFullBox,
  CttsBox,
  EdtsBox,
  ElstBox,
  findBox,
  HdlrBox,
  HvcCBox,
  It35PayloadBox,
  It35SampleEntryBox,
  KeydBox,
  KeysBox,
  MdhdBox,
  MdiaBox,
  MetaBox,
  MoovBox,
  MvhdBox,
  parseIsobmff,
  StblBox,
  StcoBox,
  StscBox,
  StsdBox,
  StssBox,
  StszBox,
  SttsBox,
  TkhdBox,
  TrackReferenceTypeBox,
  TrakBox,
  TrefBox,
} from './isobmff';
import {
  EbmlBinaryElement,
  EbmlBlockElement,
  EbmlElement,
  EbmlMasterElement,
  EbmlStringElement,
  EbmlUintElement,
  bigintToNumber,
  ID_BLOCK,
  ID_BLOCK_ADDITIONAL,
  ID_BLOCK_ADDITIONS,
  ID_BLOCK_ADD_ID,
  ID_BLOCK_DURATION,
  ID_BLOCK_GROUP,
  ID_BLOCK_MORE,
  ID_CLUSTER,
  ID_CLUSTER_TIMECODE,
  ID_CODEC_ID,
  ID_COLOUR,
  ID_COLOUR_MATRIX,
  ID_DEFAULT_DURATION,
  ID_COLOUR_PRIMARIES,
  ID_COLOUR_RANGE,
  ID_COLOUR_TRANSFER,
  ID_INFO,
  ID_REFERENCE_BLOCK,
  ID_SEGMENT,
  ID_SIMPLE_BLOCK,
  ID_TIMECODE_SCALE,
  ID_TRACKS,
  ID_TRACK_ENTRY,
  ID_TRACK_NUMBER,
  ID_TRACK_TYPE,
  ID_VIDEO,
  findEbmlElement,
  parseEbml,
  elementIsOfType
} from './webm';

interface T35Data {
  countryCode: number;
  countryCodeString?: string;
  providerCode?: number;
  providerOrientedCode?: number;
  metadataType?: ItutT35MetadataType;
  hdr10p?: Hdr10pMetadata;
  agtm?: AgtmMetadata;
}

interface SEIPayload {
  maxContentLightLevel?: number;
  maxPicAverageLightLevel?: number;
  displayPrimariesX?: number[];
  displayPrimariesY?: number[];
  whitePointX?: number;
  whitePointY?: number;
  maxDisplayMasteringLuminance?: number;
  minDisplayMasteringLuminance?: number;
  t35?: T35Data;
}

interface SEIMessage {
  payloadType: number;
  payloadTypeName: string;
  payloadSize: number;
  payload: SEIPayload;
}


interface VUI {
  colourPrimaries?: number;
  transferCharacteristics?: number;
  matrixCoefficients?: number;
  videoFullRangeFlag?: number;
}

interface SPS {
  spsVideoParameterSetId: number;
  spsMaxSubLayersMinus1: number;
  spsTemporalIdNestingFlag: number;
  spsSeqParameterSetId: number;
  chromaFormatIdc: number;
  separateColourPlaneFlag?: number;
  picWidthInLumaSamples: number;
  picHeightInLumaSamples: number;
  confWinLeftOffset?: number;
  confWinRightOffset?: number;
  confWinTopOffset?: number;
  confWinBottomOffset?: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
  log2MaxPicOrderCntLsbMinus4: number;
  vui?: VUI;
}

interface VPS {
  vpsVideoParameterSetId: number;
  vpsBaseLayerInternalFlag: number;
  vpsBaseLayerAvailableFlag: number;
  vpsMaxLayersMinus1: number;
  vpsMaxSubLayersMinus1: number;
  vpsTemporalIdNestingFlag: number;
  vpsReserved0xffff16bits: number;
  generalProfileSpace: number;
  generalTierFlag: number;
  generalProfileIdc: number;
  generalProfileCompatibilityFlags: number;
  generalConstraintIndicatorFlags: number;
  generalLevelIdc: number;
}

interface PPS {
  ppsPicParameterSetId: number;
  ppsSeqParameterSetId: number;
  dependentSliceSegmentsEnabledFlag: number;
  outputFlagPresentFlag: number;
  numExtraSliceHeaderBits: number;
  signDataHidingEnabledFlag: number;
  cabacInitPresentFlag: number;
  numRefIdxL0DefaultActiveMinus1: number;
  numRefIdxL1DefaultActiveMinus1: number;
  initQpMinus26: number;
  constrainedIntraPredFlag: number;
  transformSkipEnabledFlag: number;
}

interface MebxSample {
  localKey: string;
  keyNamespace: string;
  keyName: string;
  setuBox?: Box;
  data: Uint8Array;
}

interface WebmBlockAddition {
  id: number;
  data: Uint8Array;
}

export interface Sample {
  id: number; // Index when sorting by dts.
  trackId: number;
  offset: number;
  size: number;
  // Is this a sync sample (~= a keyframe) according to the stss
  // (SyncSampleBox) box.
  // NOTE: It is not required that every sync sample be marked by the stss
  // (SyncSampleBox) box, only that samples so marked actually be sync samples.
  isSync: boolean;
  data: Uint8Array;
  dts: number; // Decode timestamp (in timescale units).
  duration: number; // Duration of the sample (in timescale units).
  // Composition timestamp (in timescale units). Equals dts + ctts offset.
  // Represents explicitly the position on the un-edited media timeline.
  cts: number;
  // Final presentation time in seconds on the movie timeline.
  // Computed by applying the edit list ('elst') box mapping on the cts.
  // A negative value indicates that the frame is not shown.
  presentationTimeSec: number;
  // Duration of the sample in seconds on the movie timeline.
  presentationDurationSec: number;
  // For samples in a mebx track (multiplexed metadata), list of metadata
  // samples contained in this sample.
  mebxSamples?: MebxSample[];
  // For WebM samples, list of block additions (e.g. T.35 metadata).
  webmBlockAdditions?: WebmBlockAddition[];
}

export interface Chunk {
  trackId: number;
  offset: number;
  firstSample: number; // Index of the first sample in the track ().
  sampleCount: number;
  firstSampleDts: number;
}

export interface Track {
  id: number;
  samples: Sample[]; // Sorted by id/dts.
  samplesSortedByPresentationTime: Sample[]; // Sorted by presentationTimeSec.
  chunks: Chunk[];
  codec: string;
  handlerType: string;
  timescale: number;
  defaultDuration?: number; // Sample default duration, in timescale units.
  box?: TrakBox;
}

export type ItutT35MetadataType = 'AGTM' | 'HDR10+';
export type HdrMetadataType = 'CICP' | ItutT35MetadataType;

export interface FrameMetadata {
  presentationTimeSec: number;
  agtm?: AgtmMetadata;
  hdr10p?: Hdr10pMetadata;
}

export interface HdrMetadataForTrack {
  name: HdrMetadataType;
  frames: FrameMetadata[]; // Sorted by presentationTimeSec.
  // The track ID of containing this metadata.
  sourceTrackId: number;
  colourPrimaries?: number;
  transferCharacteristics?: number;
  matrixCoefficients?: number;
  // Existing metadata that was overridden by this metadata.
  overridenMetadata?: HdrMetadataForTrack;
}

interface MetadataHdrCll {
  metadataType: 1;
  typeName: 'HDR_CLL';
  maxCll: number;
  maxFall: number;
}

interface MetadataHdrMdcv {
  metadataType: 2;
  typeName: 'HDR_MDCV';
  primaryChromaticityX: number[];
  primaryChromaticityY: number[];
  whitePointChromaticityX: number;
  whitePointChromaticityY: number;
  luminanceMax: number;
  luminanceMin: number;
}

interface MetadataItutT35 {
  metadataType: 4;
  typeName: 'ITUT_T35';
  payload: T35Data;
}

interface MetadataUnknown {
  metadataType: number;
  typeName: 'Unknown';
}

type MetadataObuPayload =
  | MetadataHdrCll
  | MetadataHdrMdcv
  | MetadataItutT35
  | MetadataUnknown;

interface SequenceHeaderOBU {
  seqProfile: number;
  stillPicture: number;
  reducedStillPictureHeader: number;
  timingInfoPresentFlag?: number;
  decoderModelInfoPresentFlag?: number;
  initialDisplayDelayPresentFlag?: number;
  operatingPointsCntMinus1?: number;
  seqLevelIdx0?: number;
  seqTier0?: number;
  numTicksPerPictureMinus1?: number;
  operatingPointIdc0?: number;
  frameWidthBitsMinus1?: number;
  frameHeightBitsMinus1?: number;
  maxFrameWidthMinus1?: number;
  maxFrameHeightMinus1?: number;
  error?: string;
}

/**
 * AV1 Frame Header OBU payload.
 */
interface FrameHeaderOBU {
  showExistingFrame: number;
  frameToShowMapIdx?: number;
  frameType?: number;
  showFrame?: number;
  showableFrame?: number;
  isKeyframe: boolean;
  error?: string;
}

interface OBUHeader {
  forbiddenBit: number;
  type: number;
  typeName: string;
  extensionFlag: number;
  hasSizeField: number;
  reserved1bit: number;
  temporalId?: number;
  spatialId?: number;
  extensionHeaderReserved3bits?: number;
  internalObuSize?: number;
}

interface OBU {
  size: number; // Full size including the header and size field.
  header: OBUHeader;
  payload:
    | MetadataObuPayload
    | SequenceHeaderOBU
    | FrameHeaderOBU
    | {type: string}
    | null;
}

export interface ParsedMedia {
  containerType: 'mp4' | 'webm';
  boxes: Box[];  // For mp4.
  ebmlElements: EbmlElement[];  // For webm.
  tracks: {[trackId: string]: Track};
  numKeyframes: number;
  hdrMetadata: {[trackId: number]: {[type: string]: HdrMetadataForTrack}};
  samples: Sample[];
}

export function isKeyframe(obu: OBU): boolean {
  if (
    obu.header.type === 3 /* OBU_FRAME_HEADER */ ||
    obu.header.type === 6 /* OBU_FRAME */
  ) {
    const frameHeader = obu.payload as FrameHeaderOBU;
    return frameHeader.isKeyframe;
  }
  return false;
}

/**
 * Returns the first video track in the tracks object.
 */
export function getFirstVideoTrack(tracks: {
  [trackId: string]: Track;
}): Track | undefined {
  return Object.values(tracks).find((t) => t.handlerType === 'vide');
}

function parseHdr10p(stream: Bitstream): Hdr10pMetadata | null {
  const data: Partial<Hdr10pMetadata> = {};
  data.application_identifier = stream.readBits(8);
  if (data.application_identifier !== 4) {
    return null;
  }
  data.application_version = stream.readBits(8);
  if (data.application_version !== 1) {
    return null;
  }
  data.num_windows = stream.readBits(2);
  if (data.num_windows !== 1) {
    return null;
  }
  data.targeted_system_display_maximum_luminance = stream.readBits(27);
  data.targeted_system_display_actual_peak_luminance_flag = stream.readBits(1);
  if (data.targeted_system_display_actual_peak_luminance_flag !== 0) {
    return null;
  }
  data.windows = [];
  // Create all the windows for the array.
  for (let w = 0; w < data.num_windows; w++) {
    const window: Partial<Hdr10pWindow> = {};
    data.windows.push(window as Hdr10pWindow);
  }
  for (let w = 0; w < data.num_windows; w++) {
    const window = data.windows[w];
    window.maxscl = [];
    for (let i = 0; i < 3; i++) {
      window.maxscl[i] = stream.readBits(17);
    }
    window.average_maxrgb = stream.readBits(17);
    window.num_distributions = stream.readBits(4);
    if (window.num_distributions !== 9) {
      return null;
    }
    window.distribution_index = [];
    window.distribution_values = [];
    for (let i = 0; i < window.num_distributions; i++) {
      window.distribution_index[i] = stream.readBits(7);
      window.distribution_values[i] = stream.readBits(17);
    }
    window.fraction_bright_pixels = stream.readBits(10);
    if (window.fraction_bright_pixels !== 0) {
      return null;
    }
  }
  data.mastering_display_actual_peak_luminance_flag = stream.readBits(1);
  if (data.mastering_display_actual_peak_luminance_flag !== 0) {
    return null;
  }
  for (let w = 0; w < data.num_windows; w++) {
    const window = data.windows[w];
    window.tone_mapping_flag = stream.readBits(1);
    if (window.tone_mapping_flag) {
      window.knee_point_x = stream.readBits(12);
      window.knee_point_y = stream.readBits(12);
      window.num_bezier_curve_anchors = stream.readBits(4);
      window.bezier_curve_anchors = [];
      for (let i = 0; i < window.num_bezier_curve_anchors; i++) {
        window.bezier_curve_anchors[i] = stream.readBits(10);
      }
    }
    window.color_saturation_mapping_flag = stream.readBits(1);
    if (window.color_saturation_mapping_flag !== 0) {
      return null;
    }
  }
  return data as Hdr10pMetadata;
}

export function parseT35(payload: Uint8Array): T35Data {
  const stream = new Bitstream(payload);
  const t35: Partial<T35Data> = {};
  t35.countryCode = stream.readBits(8);
  if (t35.countryCode === 0xb5) {
    t35.countryCodeString = 'United States';
    t35.providerCode = stream.readBits(16);
    t35.providerOrientedCode = stream.readBits(16);
    if (t35.providerCode === 0x003c && t35.providerOrientedCode === 0x0001) {
      t35.metadataType = 'HDR10+';
      t35.hdr10p = parseHdr10p(stream) ?? undefined;
    } else if (
      t35.providerCode === 0x0090 &&
      t35.providerOrientedCode === 0x0001
    ) {
      t35.metadataType = 'AGTM';
      t35.agtm = parseAgtm(stream) ?? undefined;
    }
  }
  return t35 as T35Data;
}

// Reads rbsp_byte's out of a nal_unit.
// In particular, if a sequence of 0x000003 is found, the 0x03 is discarded
// (emulation_prevention_three_byte).
function getRbspBytes(data: Uint8Array): Uint8Array {
  const result: number[] = [];
  const start = 2; // Skip NALU header.
  for (let i = start; i < data.length; i++) {
    // Check for 0x000003 sequence
    if (
      i + 2 < data.length &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 3
    ) {
      result.push(data[i]);
      result.push(data[i + 1]);
      i += 2; // Skip the 0x03 byte
    } else {
      result.push(data[i]);
    }
  }
  return new Uint8Array(result);
}

class NALUParser {
  parse(data: Uint8Array): NALUnit[] {
    const nalus = [];
    let offset = 0;
    while (offset < data.length) {
      const view = new DataView(data.buffer, data.byteOffset + offset, 4);
      const naluSize = view.getUint32(0, false);
      const naluData = new Uint8Array(
        data.buffer,
        data.byteOffset + offset + 4,
        naluSize,
      );
      const naluType = (naluData[0] >> 1) & 0x3f;

      const nalu = new NALUnit(naluType, naluSize, naluData);
      nalu.parse();

      nalus.push(nalu);
      offset += 4 + naluSize;
    }
    return nalus;
  }
}
class NALUnit {
  type: number;
  size: number;
  data: Uint8Array;
  seiMessages?: SEIMessage[];
  isT35?: boolean;
  t35?: T35Data;
  hdr10p?: Hdr10pMetadata | null;
  agtm?: AgtmMetadata | null;
  vps?: VPS;
  sps?: SPS;
  pps?: PPS;
  constructor(type: number, size: number, data: Uint8Array) {
    this.type = type;
    this.size = size;
    this.data = data;
  }
  parse(): void {
    const rbspBytes = getRbspBytes(this.data);
    if (this.type === 39) {
      // SEI_PREFIX;
      this.seiMessages = this.parseSEI(rbspBytes);
      const t35msg = this.seiMessages.find(
        (msg) => msg.payloadType === 4 && msg.payload.t35,
      );
      if (t35msg) {
        this.isT35 = true;
        this.t35 = t35msg.payload.t35;
        this.hdr10p = this.t35?.hdr10p;
        this.agtm = this.t35?.agtm;
      }
    } else if (this.type === 32) {
      this.vps = NALUnit.parseVPS(rbspBytes);
    } else if (this.type === 33) {
      this.sps = NALUnit.parseSPS(rbspBytes);
    } else if (this.type === 34) {
      this.pps = NALUnit.parsePPS(rbspBytes);
    }
  }
  static parseVUI(stream: Bitstream): VUI {
    const vui: VUI = {};
    const aspectRatioInfoPresentFlag = stream.readBits(1);
    if (aspectRatioInfoPresentFlag) {
      const aspectRatioIdc = stream.readBits(8);
      if (aspectRatioIdc === 255) {
        // Extended_SAR
        stream.skipBits(16); // sar_width
        stream.skipBits(16); // sar_height
      }
    }
    const overscanInfoPresentFlag = stream.readBits(1);
    if (overscanInfoPresentFlag) {
      stream.skipBits(1); // overscan_appropriate_flag
    }
    const videoSignalTypePresentFlag = stream.readBits(1);
    if (videoSignalTypePresentFlag) {
      stream.skipBits(3); // video_format
      vui.videoFullRangeFlag = stream.readBits(1);
      const colourDescriptionPresentFlag = stream.readBits(1);
      if (colourDescriptionPresentFlag) {
        vui.colourPrimaries = stream.readBits(8);
        vui.transferCharacteristics = stream.readBits(8);
        vui.matrixCoefficients = stream.readBits(8);
      }
    }
    return vui;
  }
  static parseShortTermRefPicSet(stRpsIdx: number, stream: Bitstream) {
    const interRefPicSetPredictionFlag =
      stRpsIdx !== 0 ? stream.readBits(1) : 0;
    if (interRefPicSetPredictionFlag === 1) {
      throw new Error(
        'Parsing of inter-predicted ShortTermRefPicSet not supported.',
      );
    } else {
      const numNegativePics = stream.readUE();
      const numPositivePics = stream.readUE();
      for (let i = 0; i < numNegativePics; i++) {
        stream.readUE(); // delta_poc_s0_minus1[i]
        stream.skipBits(1); // used_by_curr_pic_s0_flag[i]
      }
      for (let i = 0; i < numPositivePics; i++) {
        stream.readUE(); // delta_poc_s1_minus1[i]
        stream.skipBits(1); // used_by_curr_pic_s1_flag[i]
      }
    }
  }
  static parseSPS(naluData: Uint8Array): SPS {
    const stream = new Bitstream(naluData);
    const sps: Partial<SPS> = {};
    sps.spsVideoParameterSetId = stream.readBits(4);
    sps.spsMaxSubLayersMinus1 = stream.readBits(3);
    sps.spsTemporalIdNestingFlag = stream.readBits(1);

    // profile_tier_level( 1, sps_max_sub_layers_minus1 )
    stream.skipBits(2); // general_profile_space
    stream.readBits(1); // general_tier_flag
    stream.readBits(5); // general_profile_idc
    stream.skipBits(32); // for( j = 0; j < 32; j++ ) general_profile_compatibility_flag[j]
    stream.skipBits(4); // various flags (u(1) general_progressive_source_flag  etc.)
    stream.skipBits(44); // if (general_profile_idc...) etc.
    stream.readBits(8); // general_level_idc
    const subLayerProfilePresentFlag = [];
    const subLayerLevelPresentFlag = [];
    for (let i = 0; i < sps.spsMaxSubLayersMinus1; i++) {
      subLayerProfilePresentFlag[i] = stream.readBits(1);
      subLayerLevelPresentFlag[i] = stream.readBits(1);
    }
    if (sps.spsMaxSubLayersMinus1 > 0) {
      for (let i = sps.spsMaxSubLayersMinus1; i < 8; i++) {
        stream.readBits(2); // reserved_zero_2bits
      }
    }
    for (let i = 0; i < sps.spsMaxSubLayersMinus1; i++) {
      if (subLayerProfilePresentFlag[i]) {
        stream.skipBits(2 + 1 + 5 + 32 + 48); //  a bunch of sub_layer_* fields
      }
      if (subLayerLevelPresentFlag[i]) {
        stream.skipBits(8); // sub_layer_level_idc
      }
    }

    sps.spsSeqParameterSetId = stream.readUE();
    sps.chromaFormatIdc = stream.readUE();
    if (sps.chromaFormatIdc === 3) {
      sps.separateColourPlaneFlag = stream.readBits(1);
    }
    sps.picWidthInLumaSamples = stream.readUE();
    sps.picHeightInLumaSamples = stream.readUE();
    const conformanceWindowFlag = stream.readBit();
    if (conformanceWindowFlag) {
      sps.confWinLeftOffset = stream.readUE();
      sps.confWinRightOffset = stream.readUE();
      sps.confWinTopOffset = stream.readUE();
      sps.confWinBottomOffset = stream.readUE();
    }
    sps.bitDepthLumaMinus8 = stream.readUE();
    sps.bitDepthChromaMinus8 = stream.readUE();
    sps.log2MaxPicOrderCntLsbMinus4 = stream.readUE();
    const subLayerOrderingInfoPresentFlag = stream.readBits(1);
    const startI = subLayerOrderingInfoPresentFlag
      ? 0
      : sps.spsMaxSubLayersMinus1;
    for (let i = startI; i <= sps.spsMaxSubLayersMinus1; i++) {
      stream.readUE(); // sps_max_dec_pic_buffering_minus1
      stream.readUE(); // sps_max_num_reorder_pics
      stream.readUE(); // sps_max_latency_increase_plus1
    }
    stream.readUE(); // log2_min_luma_coding_block_size_minus3
    stream.readUE(); // log2_diff_max_min_luma_coding_block_size
    stream.readUE(); // log2_min_luma_transform_block_size_minus2
    stream.readUE(); // log2_diff_max_min_luma_transform_block_size
    stream.readUE(); // max_transform_hierarchy_depth_inter
    stream.readUE(); // max_transform_hierarchy_depth_intra
    const scalingListEnabledFlag = stream.readBits(1);
    if (scalingListEnabledFlag) {
      const scalingListDataPresentFlag = stream.readBits(1);
      // scaling_list_data( )
      if (scalingListDataPresentFlag) {
        for (let sizeId = 0; sizeId < 4; sizeId++) {
          for (
            let matrixId = 0;
            matrixId < 6;
            matrixId += sizeId === 3 ? 3 : 1
          ) {
            const scalingListPredModFlag = stream.readBits(1);
            if (!scalingListPredModFlag) {
              stream.readUE(); // scaling_list_pred_matrix_id_delta[ sizeId ][ matrixId ]
            } else {
              if (sizeId > 1) {
                stream.readSE(); // scaling_list_dc_coef_minus8 Elysium
              }
              const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
              for (let i = 0; i < coefNum; i++) {
                stream.readSE(); // scaling_list_delta_coef
              }
            }
          }
        }
      }
    }

    stream.skipBits(1); // amp_enabled_flag
    stream.skipBits(1); // sample_adaptive_offset_enabled_flag
    const pcmEnabledFlag = stream.readBits(1);
    if (pcmEnabledFlag) {
      stream.skipBits(4); // pcm_sample_bit_depth_luma_minus1
      stream.skipBits(4); // pcm_sample_bit_depth_chroma_minus1
      stream.readUE(); // log2_min_pcm_luma_coding_block_size_minus3
      stream.readUE(); // log2_diff_max_min_pcm_luma_coding_block_size
      stream.readBits(1); // pcm_loop_filter_disabled_flag
    }
    const numShortTermRefPicSets = stream.readUE();
    for (let i = 0; i < numShortTermRefPicSets; i++) {
      NALUnit.parseShortTermRefPicSet(i, stream);
    }

    const longTermRefPicsPresentFlag = stream.readBits(1);
    if (longTermRefPicsPresentFlag) {
      const numLongTermRefPicsSps = stream.readUE();
      for (let i = 0; i < numLongTermRefPicsSps; i++) {
        stream.skipBits(sps.log2MaxPicOrderCntLsbMinus4! + 4); // lt_ref_pic_poc_lsb_sps[i]
        stream.skipBits(1); // used_by_curr_pic_lt_sps_flag[i]
      }
    }
    stream.skipBits(1); // sps_temporal_mvp_enabled_flag
    stream.skipBits(1); // strong_intra_smoothing_enabled_flag
    const vuiParametersPresentFlag = stream.readBits(1);
    if (vuiParametersPresentFlag) {
      sps.vui = NALUnit.parseVUI(stream);
    }
    // Still more stuff to parse but we're not interested in later fields.
    return sps as SPS;
  }
  static parseVPS(rbspBytes: Uint8Array): VPS {
    const stream = new Bitstream(rbspBytes);
    const vps: Partial<VPS> = {};
    vps.vpsVideoParameterSetId = stream.readBits(4);
    vps.vpsBaseLayerInternalFlag = stream.readBits(1);
    vps.vpsBaseLayerAvailableFlag = stream.readBits(1);
    vps.vpsMaxLayersMinus1 = stream.readBits(6);
    vps.vpsMaxSubLayersMinus1 = stream.readBits(3);
    vps.vpsTemporalIdNestingFlag = stream.readBits(1);
    vps.vpsReserved0xffff16bits = stream.readBits(16);
    vps.generalProfileSpace = stream.readBits(2);
    vps.generalTierFlag = stream.readBits(1);
    vps.generalProfileIdc = stream.readBits(5);
    vps.generalProfileCompatibilityFlags = stream.readBits(32);
    vps.generalConstraintIndicatorFlags = stream.readBits(48);
    vps.generalLevelIdc = stream.readBits(8);
    return vps as VPS;
  }
  static parsePPS(rbspBytes: Uint8Array): PPS {
    const stream = new Bitstream(rbspBytes);
    const pps: Partial<PPS> = {};
    pps.ppsPicParameterSetId = stream.readUE();
    pps.ppsSeqParameterSetId = stream.readUE();
    pps.dependentSliceSegmentsEnabledFlag = stream.readBits(1);
    pps.outputFlagPresentFlag = stream.readBits(1);
    pps.numExtraSliceHeaderBits = stream.readBits(3);
    pps.signDataHidingEnabledFlag = stream.readBits(1);
    pps.cabacInitPresentFlag = stream.readBits(1);
    pps.numRefIdxL0DefaultActiveMinus1 = stream.readUE();
    pps.numRefIdxL1DefaultActiveMinus1 = stream.readUE();
    pps.initQpMinus26 = stream.readSE();
    pps.constrainedIntraPredFlag = stream.readBits(1);
    pps.transformSkipEnabledFlag = stream.readBits(1);
    return pps as PPS;
  }
  private parseSEI(rbspBytes: Uint8Array): SEIMessage[] {
    const messages: SEIMessage[] = [];
    let offset = 0;
    const SEI_PAYLOAD_TYPE_NAMES: {[key: number]: string} = {
      0: 'buffering_period',
      1: 'pic_timing',
      4: 'user_data_registered_itu_t_t35',
      5: 'user_data_unregistered',
      137: 'mastering_display_colour_volume',
      144: 'content_light_level_info',
    };
    while (offset < rbspBytes.length) {
      if (rbspBytes.length - offset < 2 || rbspBytes[offset] === 0x80) break;
      let payloadType = 0;
      let lastByte = 0xff;
      while (lastByte === 0xff && offset < rbspBytes.length) {
        lastByte = rbspBytes[offset++];
        payloadType += lastByte;
      }
      let payloadSize = 0;
      lastByte = 0xff;
      while (lastByte === 0xff && offset < rbspBytes.length) {
        lastByte = rbspBytes[offset++];
        payloadSize += lastByte;
      }
      if (offset + payloadSize > rbspBytes.length) break;
      const payload = rbspBytes.subarray(offset, offset + payloadSize);
      const msg: SEIMessage = {
        payloadType,
        payloadTypeName: SEI_PAYLOAD_TYPE_NAMES[payloadType] || 'Unknown',
        payloadSize,
        payload: {},
      };
      if (payloadType === 144) {
        const view = new DataView(payload.buffer, payload.byteOffset);
        msg.payload.maxContentLightLevel = view.getUint16(0, false);
        msg.payload.maxPicAverageLightLevel = view.getUint16(2, false);
      } else if (payloadType === 137) {
        const view = new DataView(payload.buffer, payload.byteOffset);
        msg.payload.displayPrimariesX = [
          view.getUint16(0, false),
          view.getUint16(4, false),
          view.getUint16(8, false),
        ];
        msg.payload.displayPrimariesY = [
          view.getUint16(2, false),
          view.getUint16(6, false),
          view.getUint16(10, false),
        ];
        msg.payload.whitePointX = view.getUint16(12, false);
        msg.payload.whitePointY = view.getUint16(14, false);
        msg.payload.maxDisplayMasteringLuminance = view.getUint32(16, false);
        msg.payload.minDisplayMasteringLuminance = view.getUint32(20, false);
      } else if (payloadType === 4) {
        msg.payload.t35 = parseT35(payload);
      } else if (payloadType === 5) {
        // Nothing to parse for unregistered user data yet
      }
      messages.push(msg);
      offset += payloadSize;
    }
    return messages;
  }
}

/**
 * Returns the HdrMetadataForTrack for the given video track ID and type.
 * `metadataSourceTrackId` specifies the ID of the track that contains the
 * metadata, and is assumed to be the same as `videoTrackId` if not provided.
 * If a HdrMetadataForTrack does not exist yet for this video track ID and
 * type, it is created and returned.
 * If it does exist but has a different source track ID, a new
 * HdrMetadataForTrack is created to override the previous metadata,
 * keeping a reference to the previous metadata in `overriddenMetadata`.
 */
function getOrAddHdrMetadata(
  hdrMetadata: {[trackId: number]: {[type: string]: HdrMetadataForTrack}},
  videoTrackId: number,
  type: HdrMetadataType,
  metadataSourceTrackId?: number,
): HdrMetadataForTrack {
  if (!hdrMetadata[videoTrackId]) {
    hdrMetadata[videoTrackId] = {};
  }
  const sourceTrackId = metadataSourceTrackId ?? videoTrackId;
  const existing = hdrMetadata[videoTrackId][type];
  if (!existing || sourceTrackId !== existing.sourceTrackId) {
    hdrMetadata[videoTrackId][type] = {
      name: type,
      frames: [],
      sourceTrackId,
      overridenMetadata: existing,
    };
  }
  return hdrMetadata[videoTrackId][type];
}

function getHdrMetadata(
  hdrMetadata: {[trackId: number]: {[type: string]: HdrMetadataForTrack}},
  trackId: number,
  type: HdrMetadataType,
): HdrMetadataForTrack | null {
  return hdrMetadata[trackId]?.[type] ?? null;
}

function getString(view: DataView, offset: number, length: number): string {
  let str = '';
  for (let i = 0; i < length; i++) {
    str += String.fromCharCode(view.getUint8(offset + i));
  }
  return str;
}

function readBoxHeader(
  view: DataView,
  offset: number,
  isTopLevelBox: boolean,
): {size: number; type: string; headerSize: number} | null {
  if (view.byteLength < offset + 8) return null;
  let size = view.getUint32(offset, false);
  const type = getString(view, offset + 4, 4);
  let headerSize = 8;
  if (size === 1) {
    if (view.byteLength < offset + 16) return null;
    size = Number(view.getBigUint64(offset + 8, false));
    headerSize = 16;
  } else if (size === 0) {
    if (isTopLevelBox) {
      size = view.byteLength - offset;
    } else {
      // ISOBMFF Section 4.2.2:
      //  if size is 0, then this box shall be in a top-level box (i.e. not
      // contained in another box)
      return null;
    }
  }
  return {size, type, headerSize};
}

class MP4Parser {
  boxes: Box[] = [];
  tracks: {[trackId: number]: Track} = {};
  samples: Sample[] = [];
  // Real track ids cannot be zero. We use 0 to represent the 'meta' box.
  static readonly META_BOX_TRACK_ID = 0;
  hdrMetadata: {[trackId: number]: {[type: string]: HdrMetadataForTrack}} = {};
  numKeyframes = 0;
  private readonly buffer: ArrayBuffer;

  constructor(arrayBuffer: ArrayBuffer) {
    this.buffer = arrayBuffer;
  }
  parse(): Box[] {
    this.boxes = parseIsobmff(this.buffer);
    const moov = findBox(this.boxes, 'moov', MoovBox);
    if (moov) {
      for (const child of moov.children) {
        if (child.type === 'trak' && child instanceof TrakBox) {
          this.processTrak(child);
        }
      }
    }
    const meta = findBox(this.boxes, 'meta', MetaBox);
    if (meta) {
      this.processMeta(meta);
    }

    this.gatherSamples();

    // Parse metadata from lowest to highest priority:
    // - metadata in video bitstream
    // - metadata in metadata tracks
    // Later metadata will override earlier metadata if any.
    for (const trackId in this.tracks) {
      if (!Object.prototype.hasOwnProperty.call(this.tracks, trackId)) continue;
      // Video tracks.
      if (this.tracks[trackId].handlerType === 'vide') {
        this.parseTrackSamples(this.tracks[trackId]);
      }
    }
    for (const trackId in this.tracks) {
      if (!Object.prototype.hasOwnProperty.call(this.tracks, trackId)) continue;
      // Non-video tracks.
      if (this.tracks[trackId].handlerType !== 'vide') {
        this.parseTrackSamples(this.tracks[trackId]);
      }
    }

    // Sort HDR metadata frames by presentation time.
    for (const trackId in this.hdrMetadata) {
      if (!Object.prototype.hasOwnProperty.call(this.hdrMetadata, trackId)) {
        continue;
      }
      const trackMetadataMap = this.hdrMetadata[trackId];
      for (const type in trackMetadataMap) {
        if (!Object.prototype.hasOwnProperty.call(trackMetadataMap, type)) {
          continue;
        }
        trackMetadataMap[type].frames.sort(
          (a, b) => a.presentationTimeSec - b.presentationTimeSec,
        );
      }
    }

    return this.boxes;
  }

  getOrAddHdrMetadata(
    videoTrackId: number,
    type: HdrMetadataType,
    metadataSourceTrackId?: number,
  ): HdrMetadataForTrack {
    return getOrAddHdrMetadata(
      this.hdrMetadata,
      videoTrackId,
      type,
      metadataSourceTrackId,
    );
  }

  private gatherSamples(): void {
    // Create list of all samples from all tracks.
    this.samples = [];
    for (const trackId in this.tracks) {
      if (!Object.prototype.hasOwnProperty.call(this.tracks, trackId)) continue;
      const track = this.tracks[trackId];
      if (track.samples) {
        track.samples.forEach((sample) => {
          if (sample.offset && sample.size) {
            sample.data = new Uint8Array(
              this.buffer,
              sample.offset,
              sample.size,
            );
          }
        });
        this.samples.push(...track.samples);
      }
    }
    // Sort samples by offset to ensure they are in file order.
    this.samples.sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
  }

  private parseTrackSamples(track: Track): void {
    this.numKeyframes = 0;
    if (track.codec === 'av01') {
      track.samples.forEach((sample) => {
        const obuParser = new AV1OBUParser();
        const obus = obuParser.parseSample(sample.data);
        obus.forEach((obu) => {
          if (isKeyframe(obu)) {
            this.numKeyframes++;
          } else if (obu.header.type === 5 && obu.payload) {
            const metadataObuPayload = obu.payload as MetadataObuPayload;
            if (metadataObuPayload.typeName === 'ITUT_T35') {
              const itutT35Payload = metadataObuPayload as MetadataItutT35;
              if (
                itutT35Payload.payload.metadataType &&
                (itutT35Payload.payload.agtm || itutT35Payload.payload.hdr10p)
              ) {
                this.getOrAddHdrMetadata(
                  track.id,
                  itutT35Payload.payload.metadataType,
                ).frames.push({
                  presentationTimeSec: sample.presentationTimeSec,
                  agtm: itutT35Payload.payload.agtm,
                  hdr10p: itutT35Payload.payload.hdr10p,
                });
              }
            }
          }
        });
      });
    } else if (track.codec === 'hev1' || track.codec === 'hvc1') {
      track.samples.forEach((sample) => {
        if (sample.data) {
          const naluParser = new NALUParser();
          const nalus = naluParser.parse(sample.data);
          nalus.forEach((nalu) => {
            if (nalu.hdr10p) {
              this.getOrAddHdrMetadata(track.id, 'HDR10+').frames.push({
                presentationTimeSec: sample.presentationTimeSec,
                hdr10p: nalu.hdr10p,
              });
            }
            if (nalu.agtm) {
              this.getOrAddHdrMetadata(track.id, 'AGTM').frames.push({
                presentationTimeSec: sample.presentationTimeSec,
                agtm: nalu.agtm,
              });
            }
          });
        }
      });
    } else if (track.handlerType === 'meta' && track.codec === 'it35') {
      // Find the 'it35' box within the track's stsd.
      const stsd = track.box?.getDescendant('stsd', StsdBox);
      const it35Box = stsd ? stsd.getChild('it35', It35SampleEntryBox) : null;
      const t35Identifier = it35Box?.t35Identifier ?? new Uint8Array(0);

      track.samples.forEach((sample) => {
        // Concatenate the configuration data from the 'it35' box with the sample data.
        const combinedData = new Uint8Array(
          t35Identifier.length + sample.data.length,
        );
        combinedData.set(t35Identifier, 0);
        combinedData.set(sample.data, t35Identifier.length);
        const t35 = parseT35(combinedData);
        this.updateHdrMetadataFromT35(t35, track.id, track.box, sample);
      });
    } else if (track.handlerType === 'meta' && track.codec === 'mebx') {
      const keysBox = track.box?.getDescendant('keys', KeysBox);

      // Map of mebx local keys (4cc) to type info.
      const mebxTypes: {
        [type: string]: {
          keyNamespace: string;
          keyValue: string;
          setuBox: It35PayloadBox | null;
        };
      } = {};

      for (const keysChild of keysBox?.children ?? []) {
        if (!(keysChild instanceof ContainerBox)) continue;
        const keydBox = keysChild.getChild('keyd', KeydBox);
        const setuBox = keysChild.getChild('setu', It35PayloadBox);
        if (!keydBox?.keyNamespace || !keydBox?.keyValue) {
          continue;
        }
        mebxTypes[keysChild.type] = {
          keyNamespace: keydBox.keyNamespace,
          keyValue: keydBox.keyValue,
          setuBox,
        };
      }

      track.samples.forEach((sample) => {
        sample.mebxSamples = [];
        const sampleDataView = new DataView(
          sample.data.buffer,
          sample.data.byteOffset,
          sample.data.length,
        );

        // Parse boxes from sample data as a container box.
        let sampleOffset = 0;
        while (sampleOffset < sample.data.length) {
          const header = readBoxHeader(
            sampleDataView,
            sampleOffset,
            /*isTopLevelBox=*/ false,
          );
          if (!header) break;
          const {size, type, headerSize} = header;
          if (sampleOffset + size > sampleDataView.byteLength) {
            break;
          }

          const mebxType = mebxTypes[type];
          if (!mebxType) {
            sampleOffset += size; // Skip unknown mebx types.
            continue;
          }

          sample.mebxSamples.push({
            localKey: type,
            keyNamespace: mebxType.keyNamespace,
            keyName: mebxType.keyValue,
            setuBox: mebxType.setuBox ?? undefined,
            data: new Uint8Array(
              sample.data.buffer,
              sample.data.byteOffset + sampleOffset + headerSize,
              size - headerSize,
            ),
          });

          if (
            mebxType.keyNamespace !== 'me4c' ||
            mebxType.keyValue !== 'it35' ||
            !mebxType.setuBox?.t35Identifier
          ) {
            sampleOffset += size;
            continue;
          }
          const t35Identifier = mebxType.setuBox?.t35Identifier;
          const t35Payload = sample.data.subarray(
            sampleOffset + headerSize,
            sampleOffset + size,
          );

          const combinedData = new Uint8Array(
            t35Identifier.length + t35Payload.length,
          );
          combinedData.set(t35Identifier, 0);
          combinedData.set(t35Payload, t35Identifier.length);
          const t35 = parseT35(combinedData);
          this.updateHdrMetadataFromT35(t35, track.id, track.box, sample);
          sampleOffset += size;
        }
      });
    }
  }

  private updateHdrMetadataFromT35(
    t35: T35Data,
    metadataTrackId: number,
    metadataTrackBox: TrakBox|undefined,
    sample: Sample,
  ): void {
    const tref = metadataTrackBox?.getChild('tref', TrefBox);
    const trefChildBox =
      tref?.getChild('cdsc', TrackReferenceTypeBox) ??
      tref?.getChild('rndr', TrackReferenceTypeBox);
    let trackIds = trefChildBox?.trackIds;
    // ISOBMFF (14496-12:2022) Section 12.3.1:
    //   Metadata tracks should be linked to the track they describe using a
    //   track-reference of type 'cdsc'.
    // For increased compatibility, if cdsc or rndr (proposed by Apple) is
    // missing we assume that the metadata track applies to all video tracks.
    if (!trackIds || trackIds.length === 0) {
      const videoTracks = Object.values(this.tracks).filter(
        (t) => t.handlerType === 'vide',
      );
      trackIds = videoTracks.map((t) => t.id);
    }
    // Otherwise just record it as describing itself.
    if (!trackIds || trackIds.length === 0) {
      trackIds = [metadataTrackId];
    }

    const presentationTimeSec = sample.presentationTimeSec;
    if (presentationTimeSec < 0) return; // Unpresented frame

    for (const trackId of trackIds) {
      const videoTrack = this.tracks[trackId];
      if (!videoTrack) continue;

      if (t35.metadataType && (t35.agtm || t35.hdr10p)) {
        this.getOrAddHdrMetadata(
          trackId,
          t35.metadataType,
          metadataTrackId,
        ).frames.push({
          presentationTimeSec,
          agtm: t35.agtm ?? undefined,
          hdr10p: t35.hdr10p ?? undefined,
        });
      }
    }
  }

  private getCodec(trakBox: TrakBox): string {
    const stsd = trakBox.getDescendant('stsd', StsdBox);
    if (stsd && stsd.children.length > 0) {
      return stsd.children[0].type;
    }
    return 'unknown';
  }

  private extractCicpFromHevcConfig(trakBox: TrakBox, trackId: number): void {
    const hvcC = trakBox.getDescendant('hvcC', HvcCBox);
    if (!hvcC) return;
    const naluArrays = hvcC.naluArrays;
    for (const naluArray of naluArrays) {
      const nalus = naluArray.nalus.map((nalu) => {
        const result: {sps?: SPS} = {};
        const rbspBytes = getRbspBytes(nalu.data);
        if (naluArray.naluType === 33) {
          result.sps = NALUnit.parseSPS(rbspBytes);
        }
        return result;
      });
      for (const nalu of nalus) {
        if (nalu.sps && nalu.sps.vui) {
          const vui = nalu.sps.vui;
          if (
            vui.colourPrimaries !== undefined &&
            vui.transferCharacteristics !== undefined &&
            vui.matrixCoefficients !== undefined
          ) {
            const cicp = this.getOrAddHdrMetadata(trackId, 'CICP');
            cicp.colourPrimaries = vui.colourPrimaries;
            cicp.transferCharacteristics = vui.transferCharacteristics;
            cicp.matrixCoefficients = vui.matrixCoefficients;
            return; // Found and added
          }
        }
      }
    }
  }

  private processMeta(metaBox: MetaBox): void {
    this.extractCicpFromColrBox(metaBox, MP4Parser.META_BOX_TRACK_ID);
  }

  private processTrak(trakBox: TrakBox): void {
    const tkhd = trakBox.getChild('tkhd', TkhdBox);
    const mdia = trakBox.getChild('mdia', MdiaBox);
    // Return early if any mandatory box is missing.
    if (!tkhd || !mdia) return;
    const trackId = tkhd.trackId;
    if (!trackId) return;
    const hdlr = mdia.getChild('hdlr', HdlrBox);
    const mdhd = mdia.getChild('mdhd', MdhdBox);
    if (!hdlr || !mdhd) return;

    this.tracks[trackId] = {
      id: trackId,
      samples: [],
      samplesSortedByPresentationTime: [],
      chunks: [],
      codec: this.getCodec(trakBox),
      handlerType: hdlr.handlerType,
      timescale: mdhd.timescale,
      box: trakBox,
    };

    this.extractCicpFromColrBox(trakBox, trackId);
    // If the CICP could not be extracted from the colr box, try the HEVC config NALU.
    if (!this.hdrMetadata[trackId]?.['CICP']) {
      this.extractCicpFromHevcConfig(trakBox, trackId);
    }

    const stbl = mdia.getDescendant('stbl', StblBox);
    if (!stbl) return;
    const stsz = stbl.getChild('stsz', StszBox);
    const stco =
      stbl.getChild('stco', StcoBox) || stbl.getChild('co64', Co64Box);
    const stsc = stbl.getChild('stsc', StscBox);
    const stts = stbl.getChild('stts', SttsBox);
    if (!stsz || !stco || !stsc || !stts) return;
    if (!stsc.entries.length || !stts.entries.length) return;
    // Optional boxes.
    const stss = stbl.getChild('stss', StssBox);
    const ctts = stbl.getChild('ctts', CttsBox);

    const sampleCount = stsz.sampleCount;
    if (sampleCount === 0) return;

    // 1. Get sample sizes
    const sampleSizes: number[] = [];
    const sampleSize = stsz.sampleSize;
    if (sampleSize === 0) {
      sampleSizes.push(...stsz.sampleSizes);
    } else {
      for (let i = 0; i < sampleCount; i++) {
        sampleSizes.push(sampleSize);
      }
    }

    // 2. Get chunk offsets
    const chunkOffsets = stco.chunkOffsets;
    const chunkCount = chunkOffsets.length;

    // 3. Build a complete chunk map (samples per chunk)
    const stscEntries = stsc.entries;
    const samplesPerChunk: number[] = new Array(chunkCount);
    if (stscEntries.length === 0) return; // Should not happen.
    let stscEntryIndex = 0;
    for (let i = 1; i <= chunkCount; i++) {
      if (
        stscEntryIndex < stscEntries.length - 1 &&
        i === stscEntries[stscEntryIndex + 1].firstChunk
      ) {
        stscEntryIndex++;
      }
      samplesPerChunk[i - 1] = stscEntries[stscEntryIndex].samplesPerChunk;
    }

    // 4. Calculate DTS and Duration from stts
    const dtsValues: number[] = new Array(sampleCount);
    const durations: number[] = new Array(sampleCount);
    let currentDts = 0;
    let sampleIdx = 0;
    stts.entries.forEach((entry) => {
      for (let i = 0; i < entry.sampleCount; i++) {
        if (sampleIdx < sampleCount) {
          dtsValues[sampleIdx] = currentDts;
          durations[sampleIdx] = entry.sampleDelta;
          currentDts += entry.sampleDelta;
          sampleIdx++;
        }
      }
    });

    // 5. Calculate CTS (Composition Time) from dtsValues and ctts
    const cttsEntries = ctts?.entries;
    const ctsValues: number[] = new Array(sampleCount);
    if (cttsEntries) {
      sampleIdx = 0;
      cttsEntries.forEach((entry) => {
        for (let i = 0; i < entry.sampleCount; i++) {
          if (sampleIdx < sampleCount) {
            ctsValues[sampleIdx] = dtsValues[sampleIdx] + entry.sampleOffset;
            sampleIdx++;
          }
        }
      });
    } else {
      for (let i = 0; i < sampleCount; i++) {
        ctsValues[i] = dtsValues[i];
      }
    }

    // 6. Calculate Offset, Size, and IsSync by iterating through chunks
    const offsets: number[] = new Array(sampleCount);
    const sizes: number[] = new Array(sampleCount);
    const isSyncs: boolean[] = new Array(sampleCount);
    const syncSamples = stss ? new Set<number>(stss.sampleNumbers) : null;

    sampleIdx = 0;
    for (let chunkIdx = 0; chunkIdx < chunkCount; chunkIdx++) {
      const samplesInChunk = samplesPerChunk[chunkIdx];
      let sampleOffsetInChunk = 0;
      for (let i = 0; i < samplesInChunk; i++) {
        const sampleSize = sampleSizes[sampleIdx];
        // If the SyncSampleBox is not present, every sample is a sync sample.
        const isSync = syncSamples ? syncSamples.has(sampleIdx + 1) : true;
        offsets[sampleIdx] = chunkOffsets[chunkIdx] + sampleOffsetInChunk;
        sizes[sampleIdx] = sampleSize;
        isSyncs[sampleIdx] = isSync;
        sampleOffsetInChunk += sampleSize;
        sampleIdx++;
        if (sampleIdx >= sampleCount) break;
      }
    }

    // 7. Construct all Sample objects in one place
    const samples: Sample[] = [];
    // Find the edit list box to compute presentation times.
    const moovBox = findBox(this.boxes, 'moov', MoovBox);
    const mvhdBox = moovBox?.getChild('mvhd', MvhdBox);
    const movieTimescale = (mvhdBox?.timescale ?? mdhd.timescale) || 1;
    const elstBox = trakBox
      .getChild('edts', EdtsBox)
      ?.getChild('elst', ElstBox);

    for (let i = 0; i < sampleCount; i++) {
      const cts = ctsValues[i];
      // Compute the presentation time.
      let presentationTimeSec = -1;
      let presentationDurationSec = durations[i] / mdhd.timescale;
      if (elstBox && elstBox.entries.length > 0) {
        let currentMovieTime = 0;
        for (const entry of elstBox.entries) {
          if (entry.mediaTime === -1) {
            // mediaTime of -1 indicates an "empty edit".
            // An empty edit is used to offset the start time of a track.
            currentMovieTime += entry.editDuration;
            continue;
          }

          const mediaRate = entry.mediaRate;
          if (mediaRate === 0) {
            // mediaRate of 0 indicates a 'dwell'. The media at mediaTime is presented for editDuration.
            if (cts === entry.mediaTime) {
              presentationTimeSec = currentMovieTime / movieTimescale;
              presentationDurationSec = entry.editDuration / movieTimescale;
            }
          } else {
            const editDurationInMediaSeconds =
              (entry.editDuration / movieTimescale) * mediaRate;
            const editDurationInTrackCts =
              editDurationInMediaSeconds * mdhd.timescale;

            if (
              cts >= entry.mediaTime &&
              cts < entry.mediaTime + editDurationInTrackCts
            ) {
              const offsetInMediaCts = cts - entry.mediaTime;
              const offsetInMediaSeconds = offsetInMediaCts / mdhd.timescale;
              const offsetInSegmentMovieUnits =
                (offsetInMediaSeconds / mediaRate) * movieTimescale;
              presentationTimeSec =
                (currentMovieTime + offsetInSegmentMovieUnits) / movieTimescale;
              presentationDurationSec =
                durations[i] / (mdhd.timescale * mediaRate);
            }
          }
          currentMovieTime += entry.editDuration;
        }
      } else {
        // The EditBox is optional. In the absence of this box, there is an
        // implicit one-to-one mapping of these timelines, and the presentation of
        // a track starts at the beginning of the presentation.
        presentationTimeSec = cts / mdhd.timescale;
      }

      samples.push({
        id: i,
        trackId,
        offset: offsets[i],
        size: sizes[i],
        isSync: isSyncs[i],
        dts: dtsValues[i],
        duration: durations[i],
        cts,
        presentationTimeSec,
        presentationDurationSec,
        data: new Uint8Array(0), // data is populated in gatherSamples
      });
    }
    this.tracks[trackId].samples = samples;

    // 8. Populate chunks.
    this.tracks[trackId].chunks = [];
    let firstSampleIndexInTrack = 0;
    for (let i = 0; i < chunkCount; i++) {
      const numSamplesInChunk = samplesPerChunk[i];
      if (!numSamplesInChunk) {
        // Error already logged in step 6.
        continue;
      }
      const firstSample = this.tracks[trackId].samples[firstSampleIndexInTrack];
      this.tracks[trackId].chunks.push({
        trackId,
        offset: chunkOffsets[i],
        firstSample: firstSampleIndexInTrack,
        sampleCount: numSamplesInChunk,
        firstSampleDts: firstSample.dts,
      });
      firstSampleIndexInTrack += numSamplesInChunk;
    }

    // 9. Sort samples by final presentation time.
    // We only keep samples mapped onto the timeline.
    this.tracks[trackId].samplesSortedByPresentationTime = [
      ...this.tracks[trackId].samples,
    ]
      .filter((a) => a.presentationTimeSec >= 0)
      .sort((a, b) => a.presentationTimeSec - b.presentationTimeSec);
  }

  private extractCicpFromColrBox(
    container: ContainerBox | ContainerFullBox,
    trackId: number,
  ): void {
    const colrBox = container.getDescendant('colr', ColrBox);
    if (!colrBox) return;
    if (colrBox.colourType === 'nclx') {
      const colourPrimaries = colrBox.colorPrimaries;
      const transferCharacteristics = colrBox.transferFunction;
      const matrixCoefficients = colrBox.matrixCoefficients;

      if (
        typeof colourPrimaries === 'number' &&
        typeof transferCharacteristics === 'number' &&
        typeof matrixCoefficients === 'number'
      ) {
        const cicp = this.getOrAddHdrMetadata(trackId, 'CICP');
        cicp.colourPrimaries = colourPrimaries;
        cicp.transferCharacteristics = transferCharacteristics;
        cicp.matrixCoefficients = matrixCoefficients;
      }
    }
  }
}

class AV1OBUParser {
  private readonly OBU_TYPE_NAMES: {[key: number]: string} = {
    0: 'OBU_RESERVED_0',
    1: 'OBU_SEQUENCE_HEADER',
    2: 'OBU_TEMPORAL_DELIMITER',
    3: 'OBU_FRAME_HEADER',
    4: 'OBU_TILE_GROUP',
    5: 'OBU_METADATA',
    6: 'OBU_FRAME',
    7: 'OBU_REDUNDANT_FRAME_HEADER',
    8: 'OBU_TILE_LIST',
    15: 'OBU_PADDING',
  };

  parseSample(sampleBuffer: Uint8Array): OBU[] {
    const reader = new Bitstream(sampleBuffer);
    const obus: OBU[] = [];
    while (reader.bytesLeft() > 1) {
      const obuStart = reader.bytePosition;

      const obuHeader: Partial<OBUHeader> = {};
      obuHeader.forbiddenBit = reader.readBits(1);
      obuHeader.type = reader.readBits(4);
      obuHeader.typeName =
        this.OBU_TYPE_NAMES[obuHeader.type] || 'Unknown/Reserved';
      obuHeader.extensionFlag = reader.readBits(1);
      obuHeader.hasSizeField = reader.readBits(1);
      obuHeader.reserved1bit = reader.readBits(1);
      if (obuHeader.extensionFlag) {
        obuHeader.temporalId = reader.readBits(3);
        obuHeader.spatialId = reader.readBits(2);
        obuHeader.extensionHeaderReserved3bits = reader.readBits(3);
      }
      let payloadSize;
      if (obuHeader.hasSizeField) {
        const internalObuSize = reader.readUleb128();
        payloadSize = internalObuSize;
      } else {
        throw new Error('OBU size unknown!');
        // This case is for when the OBU size is provided externally:
        // payloadSize = totalObuSize - 1 - obuHeader.extensionFlag;
      }
      const headerSize = reader.bytePosition - obuStart;
      const parsedOBU: OBU = {
        size: headerSize + payloadSize,
        header: obuHeader as OBUHeader,
        payload: null,
      };
      if (obuHeader.hasSizeField) {
        parsedOBU.header.internalObuSize = payloadSize;
      }
      const payloadReader = new Bitstream(
        sampleBuffer.subarray(
          reader.bytePosition,
          reader.bytePosition + payloadSize,
        ),
      );

      switch (obuHeader.type) {
        case 1: // OBU_SEQUENCE_HEADER
          parsedOBU.payload = this.parseSequenceHeader(payloadReader);
          break;
        case 3: // OBU_FRAME_HEADER
        case 6: // OBU_FRAME which starts the same as OBU_FRAME_HEADER
          parsedOBU.payload = this.parseFrameHeader(payloadReader);
          break;
        case 5: // OBU_METADATA
          parsedOBU.payload = this.parseMetadataOBU(payloadReader);
          break;
        default:
          parsedOBU.payload = {type: 'Unhandled'};
          break;
      }
      obus.push(parsedOBU);
      reader.bytePosition += payloadSize;
    }
    return obus;
  }
  private parseMetadataOBU(reader: Bitstream): MetadataObuPayload {
    const metadataType = reader.readUleb128();

    // You can add more specific metadata parsers here based on metadata_type
    switch (metadataType) {
      case 1: // METADATA_TYPE_HDR_CLL
        return {
          metadataType: 1,
          typeName: 'HDR_CLL',
          maxCll: reader.readBits(16),
          maxFall: reader.readBits(16),
        };
      case 2: // METADATA_TYPE_HDR_MDCV
        const primaryChromaticityX: number[] = [];
        const primaryChromaticityY: number[] = [];
        for (let i = 0; i < 3; i++) {
          primaryChromaticityX.push(reader.readBits(16));
          primaryChromaticityY.push(reader.readBits(16));
        }
        return {
          metadataType: 2,
          typeName: 'HDR_MDCV',
          primaryChromaticityX,
          primaryChromaticityY,
          whitePointChromaticityX: reader.readBits(16),
          whitePointChromaticityY: reader.readBits(16),
          luminanceMax: reader.readBits(32),
          luminanceMin: reader.readBits(32),
        };
      case 4: // METADATA_TYPE_ITUT_T35
        return {
          metadataType: 4,
          typeName: 'ITUT_T35',
          payload: this.parseItutT35(reader),
        };
      default:
        return {
          metadataType,
          typeName: 'Unknown',
        };
    }
  }
  private parseItutT35(reader: Bitstream): T35Data {
    const payload = reader.uint8Array.subarray(reader.bytePosition);
    return parseT35(payload);
  }

  private parseSequenceHeader(reader: Bitstream): SequenceHeaderOBU {
    const seqHeader: Partial<SequenceHeaderOBU> = {};
    try {
      seqHeader.seqProfile = reader.readBits(3);
      seqHeader.stillPicture = reader.readBits(1);
      seqHeader.reducedStillPictureHeader = reader.readBits(1);

      if (seqHeader.reducedStillPictureHeader) {
        seqHeader.timingInfoPresentFlag = 0;
        seqHeader.decoderModelInfoPresentFlag = 0;
        seqHeader.initialDisplayDelayPresentFlag = 0;
        seqHeader.operatingPointsCntMinus1 = 0;
        seqHeader.seqLevelIdx0 = reader.readBits(5);
        seqHeader.seqTier0 = 0;
      } else {
        let bufferDelayLengthMinus1 = 0;
        seqHeader.timingInfoPresentFlag = reader.readBits(1);
        if (seqHeader.timingInfoPresentFlag) {
          // timing_info()
          reader.readBits(32); // num_units_in_display_tick
          reader.readBits(32); // time_scale
          const equalPictureInterval = reader.readBits(1);
          if (equalPictureInterval) {
            seqHeader.numTicksPerPictureMinus1 = reader.readUvlc();
          }
          seqHeader.decoderModelInfoPresentFlag = reader.readBits(1);
          if (seqHeader.decoderModelInfoPresentFlag) {
            // decoder_model_info()
            bufferDelayLengthMinus1 = reader.readBits(5);
            reader.readBits(32); // num_units_in_decoding_tick
            reader.readBits(5); // buffer_removal_time_length_minus_1
            reader.readBits(5); // frame_presentation_time_length_minus_1
          }
        }

        seqHeader.initialDisplayDelayPresentFlag = reader.readBits(1);

        const operatingPointsCntMinus1 = reader.readBits(5);
        seqHeader.operatingPointsCntMinus1 = operatingPointsCntMinus1;
        for (let i = 0; i <= operatingPointsCntMinus1; i++) {
          const operatingPointIdc = reader.readBits(12);
          const seqLevelIdx = reader.readBits(5);

          let seqTier;
          if (seqLevelIdx > 7) {
            seqTier = reader.readBits(1);
          } else {
            seqTier = 0;
          }
          if (i === 0) {
            seqHeader.operatingPointIdc0 = operatingPointIdc;
            seqHeader.seqLevelIdx0 = seqLevelIdx;
            seqHeader.seqTier0 = seqTier;
          }
          if (seqHeader.decoderModelInfoPresentFlag) {
            const decoderModelPresentForThisOp = reader.readBits(1);
            if (decoderModelPresentForThisOp) {
              const n = bufferDelayLengthMinus1 + 1;
              reader.readBits(n); // decoder_buffer_delay
              reader.readBits(n); // encoder_buffer_delay
              reader.readBits(1); // low_delay_mode_flag
            }
          }
          if (seqHeader.initialDisplayDelayPresentFlag) {
            const initialDisplayDelayPresentForThisOp = reader.readBits(1);
            if (initialDisplayDelayPresentForThisOp) {
              reader.readBits(4); // initial_display_delay_minus_1
            }
          }
        }
      }

      seqHeader.frameWidthBitsMinus1 = reader.readBits(4);
      seqHeader.frameHeightBitsMinus1 = reader.readBits(4);
      const frameWidthBits = seqHeader.frameWidthBitsMinus1 + 1;
      seqHeader.maxFrameWidthMinus1 = reader.readBits(frameWidthBits);
      const frameHeightBits = seqHeader.frameHeightBitsMinus1 + 1;
      seqHeader.maxFrameHeightMinus1 = reader.readBits(frameHeightBits);
    } catch (e: unknown) {
      if (e instanceof Error) {
        seqHeader.error = e.message;
      }
    }
    return seqHeader as SequenceHeaderOBU;
  }

  private parseFrameHeader(reader: Bitstream): FrameHeaderOBU {
    const frameHeader: Partial<FrameHeaderOBU> = {};
    frameHeader.showExistingFrame = reader.readBits(1);
    if (frameHeader.showExistingFrame === 1) {
      frameHeader.frameToShowMapIdx = reader.readBits(3);
      frameHeader.isKeyframe = false;
      return frameHeader as FrameHeaderOBU;
    }
    frameHeader.frameType = reader.readBits(2);
    frameHeader.showFrame = reader.readBits(1);
    if (frameHeader.showFrame === 0) {
      frameHeader.showableFrame = reader.readBits(1);
    } else {
      frameHeader.showableFrame = Number(frameHeader.frameType !== 0);
    }

    frameHeader.isKeyframe =
      frameHeader.showExistingFrame === 0 &&
      frameHeader.frameType === 0 && // KEY_FRAME
      frameHeader.showFrame === 1;
    return frameHeader as FrameHeaderOBU;
  }
}

/**
 * Returns the index of the sample in the given track at the given time, in
 * presentation order.
 * @param track The track to search.
 * @param time The time in seconds to retrieve the metadata for.
 * @return The index of the sample, or null if not found.
 */
export function findTrackSampleIndexForTime(
  track: Track,
  time: number,
): number | null {
  if (track.samplesSortedByPresentationTime.length === 0) return null;
  const samples = track.samplesSortedByPresentationTime;
  return findSampleIndexForTime(samples, time);
}

/**
 * Returns the index of the sample at the given time, in presentation order.
 * The samples must be sorted by presentation time.
 */
function findSampleIndexForTime(
  samples: Array<{presentationTimeSec: number}>,
  time: number,
): number | null {
  const epsilon = 1e-6;
  let low = 0;
  let high = samples.length - 1;

  // Binary search to find the largest index i such that samples[i].presentationTimeSec <= time + epsilon
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].presentationTimeSec <= time + epsilon) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const index = low - 1;
  return index < 0 ? null : index;
}

/**
 * Returns the approximate framerate of the video track.
 * @param parsedMp4 The parsed MP4 file.
 * @returns The framerate, or null if it cannot be determined.
 */
export function getAverageFramerate(parsedMp4: ParsedMedia): number | null {
  const videoTrack = getFirstVideoTrack(parsedMp4.tracks);
  if (!videoTrack || !videoTrack.samples.length || !videoTrack.timescale) {
    return null;
  }
  if (!videoTrack.box) {
    const numSamples = videoTrack.samples.length;
    if (numSamples === 0) return null;
    const lastSample = videoTrack.samples[numSamples - 1];
    const durationSec = lastSample.presentationTimeSec + lastSample.presentationDurationSec;
    return durationSec > 0 ? numSamples / durationSec : null;
  }
  const mdhd = videoTrack.box.getDescendant('mdhd', MdhdBox);
  if (!mdhd) {
    return null;
  }

  const duration = mdhd.duration;
  if (!duration) {
    return null;
  }
  const numSamples = videoTrack.samples.length;
  const timescale = videoTrack.timescale;

  return (numSamples * timescale) / duration;
}

/**
 * Returns the CICP metadata from the video file.
 * @param parsedMp4 The parsed MP4/WebM file.
 * @returns The CICP metadata object, or null if not found.
 */
export function getCicp(
  parsedMp4: ParsedMedia,
): Partial<HdrMetadataForTrack> | null {
  try {
    const videoTrack = getFirstVideoTrack(parsedMp4.tracks);
    const trackId = videoTrack ? videoTrack.id : MP4Parser.META_BOX_TRACK_ID;
    const cicp = getHdrMetadata(parsedMp4.hdrMetadata, trackId, 'CICP');
    if (!cicp) return null;
    if (
      cicp.colourPrimaries === undefined ||
      cicp.matrixCoefficients === undefined ||
      cicp.transferCharacteristics === undefined
    ) {
      return null;
    }
    return cicp;
  } catch (error: unknown) {
    return null;
  }
}

interface TrackMetadata {
  hdr10p?: Hdr10pMetadata;
  agtm?: AgtmMetadata;
  error?: string;
}

function getHDRMetadata(
  parsedMp4: ParsedMedia,
  time: number,
  metadataType: HdrMetadataType,
): TrackMetadata {
  try {
    const videoTrack = getFirstVideoTrack(parsedMp4.tracks);
    if (!videoTrack) return {error: '(No video track)'};
    const trackMetadata = getHdrMetadata(
      parsedMp4.hdrMetadata,
      videoTrack.id,
      metadataType,
    );
    if (!trackMetadata) {
      return {error: '(No metadata of type ' + metadataType + ' found)'};
    }
    if (!trackMetadata.frames || trackMetadata.frames.length === 0) {
      return {error: '(No input frame)'};
    }
    const index = findSampleIndexForTime(trackMetadata.frames, time);
    if (index === null) {
      return {error: '(No metadata found for frame)'};
    }
    return trackMetadata.frames[index];
  } catch (error: unknown) {
    if (error instanceof Error) {
      return {error: `(Error: ${error.message})`};
    }
    return {error: `(Error)`};
  }
}

/**
 * Returns the SMPTE 2094.40 (HDR10+) metadata from the video file.
 * @param parsedMp4 The parsed video file.
 * @param time The time in seconds to retrieve the metadata for.
 * @returns The SMPTE 2094.40 metadata object, or null if not found.
 */
export function getSmpte209440Metadata(
  parsedMp4: ParsedMedia,
  time: number,
): Hdr10pMetadata | string {
  const metadata = getHDRMetadata(parsedMp4, time, 'HDR10+');
  if (metadata.error) {
    return metadata.error;
  }
  return metadata.hdr10p ?? "Couldn't find HDR10+ metadata";
}

export function getAgtmMetadata(
  parsedMp4: ParsedMedia,
  time: number,
): AgtmMetadata | string {
  const metadata = getHDRMetadata(parsedMp4, time, 'AGTM');
  if (metadata.error) {
    return metadata.error;
  }
  return metadata.agtm ?? "Couldn't find AGTM metadata";
}

/**
 * Removes a track from the movie.
 * @param mp4 The parsed video file.
 * @param trackId The ID of the track to remove.
 */
export function removeTrack(mp4: ParsedMedia, trackId: number): void {
  const track = mp4.tracks[trackId];
  if (!track) {
    return;
  }

  const moovBox = findBox(mp4.boxes, 'moov', MoovBox);
  if (moovBox) {
    moovBox.children = moovBox.children.filter((child) => child !== track.box);
  }
  mp4.samples = mp4.samples.filter((sample) => sample.trackId !== trackId);
  delete mp4.tracks[trackId];
  if (mp4.hdrMetadata[trackId]) {
    delete mp4.hdrMetadata[trackId];
  }
}

export function parseMp4(arrayBuffer: ArrayBuffer): ParsedMedia | null {
  try {
    const mp4Parser = new MP4Parser(arrayBuffer);
    mp4Parser.parse();
    return {
      containerType: 'mp4',
      boxes: mp4Parser.boxes,
      ebmlElements: [],
      tracks: mp4Parser.tracks,
      numKeyframes: mp4Parser.numKeyframes,
      hdrMetadata: mp4Parser.hdrMetadata,
      samples: mp4Parser.samples,
    };
  } catch (error: unknown) {
    console.error('Error parsing MP4:', error);
    return null;
  }
}

/**
 * Returns the equivalent MP4 handler type for the given MKV track type.
 */
function mkvTrackTypeToMp4Handler(trackType: number | undefined): string {
  switch (trackType) {
    case 1:
      return 'vide';
    case 2:
      return 'soun';
    case 17:
      return 'subt';
    case 33:
      return 'meta';
    default:
      return 'unknown';
  }
}

class WebmParser {
  elements: EbmlElement[] = [];
  tracks: {[trackId: number]: Track} = {};
  samples: Sample[] = [];
  hdrMetadata: {[trackId: number]: {[type: string]: HdrMetadataForTrack}} = {};
  numKeyframes = 0;
  private readonly buffer: ArrayBuffer;

  constructor(arrayBuffer: ArrayBuffer) {
    this.buffer = arrayBuffer;
  }

  parse(): EbmlElement[] {
    const elements = parseEbml(this.buffer);
    this.elements = elements;
    const segment = findEbmlElement(elements, ID_SEGMENT, EbmlMasterElement);
    if (!segment) return elements;

    let timecodeScale = 1000000;
    const info = segment.getChild(ID_INFO, EbmlMasterElement);
    if (info) {
      const ts = info.getChild(ID_TIMECODE_SCALE, EbmlUintElement);
      if (ts) timecodeScale = bigintToNumber(ts.value) ?? 1000000;
    }

    const tracksEl = segment.getChild(ID_TRACKS, EbmlMasterElement);
    if (tracksEl) {
      for (const trackEntry of tracksEl.children) {
        if (!elementIsOfType(trackEntry, ID_TRACK_ENTRY, EbmlMasterElement)) {
          continue;
        }
        const trackNum = bigintToNumber(
          trackEntry.getChild(ID_TRACK_NUMBER, EbmlUintElement)?.value,
        );
        const trackType = (trackEntry.getChild(ID_TRACK_TYPE, EbmlUintElement))
          ?.value;
        const codecId = (trackEntry.getChild(ID_CODEC_ID, EbmlStringElement))
          ?.value;
        const defaultDurationNs = bigintToNumber(
          trackEntry.getChild(ID_DEFAULT_DURATION, EbmlUintElement)?.value,
        );

        if (trackNum !== undefined) {
          const video = trackEntry.getChild(ID_VIDEO, EbmlMasterElement);
          let primaries, transfer, matrix, range;
          if (video) {
            const colour = video.getChild(ID_COLOUR, EbmlMasterElement);
            if (colour) {
              primaries = bigintToNumber(
                colour.getChild(ID_COLOUR_PRIMARIES, EbmlUintElement)?.value,
              );
              transfer = bigintToNumber(
                colour.getChild(ID_COLOUR_TRANSFER, EbmlUintElement)?.value,
              );
              matrix = bigintToNumber(
                colour.getChild(ID_COLOUR_MATRIX, EbmlUintElement)?.value,
              );
              range = bigintToNumber(
                colour.getChild(ID_COLOUR_RANGE, EbmlUintElement)?.value,
              );
            }
          }

          this.tracks[trackNum] = {
            id: trackNum,
            samples: [],
            samplesSortedByPresentationTime: [],
            chunks: [],
            codec:
              codecId === 'V_VP9'
                ? 'vp09'
                : codecId === 'V_AV1'
                  ? 'av01'
                  : 'unknown',
            handlerType: mkvTrackTypeToMp4Handler(bigintToNumber(trackType)),
            timescale: 1e9 / timecodeScale,
            defaultDuration: defaultDurationNs ? (defaultDurationNs / timecodeScale) : undefined,
          };

          if (
            primaries !== undefined &&
            transfer !== undefined &&
            matrix !== undefined
          ) {
            const cicp = getOrAddHdrMetadata(this.hdrMetadata, trackNum, 'CICP');
            cicp.colourPrimaries = primaries;
            cicp.transferCharacteristics = transfer;
            cicp.matrixCoefficients = matrix;
          }
        }
      }
    }

    // Parse Clusters for samples
    for (const cluster of segment.children) {
      if (!elementIsOfType(cluster, ID_CLUSTER, EbmlMasterElement))
        continue;
      let clusterTimecode = 0;
      const ct = cluster.getChild(ID_CLUSTER_TIMECODE, EbmlUintElement);
      if (ct) clusterTimecode = bigintToNumber(ct.value) ?? 0;

      for (const child of cluster.children) {
        if (elementIsOfType(child, ID_SIMPLE_BLOCK, EbmlBlockElement)) {
          this.processBlock(child, clusterTimecode, timecodeScale, bigintToNumber(child.trackNum) ?? 0);
        } else if (elementIsOfType(child, ID_BLOCK_GROUP, EbmlMasterElement)) {
          const block = child.getChild(ID_BLOCK, EbmlBlockElement);
          const trackNum = bigintToNumber(block?.trackNum);
          if (block && trackNum !== undefined && this.tracks[trackNum]) {
            const duration = bigintToNumber(
              child.getChild(ID_BLOCK_DURATION, EbmlUintElement)?.value,
            );
            const additions = child.getChild(
              ID_BLOCK_ADDITIONS, EbmlMasterElement);
            const referenceBlock = child.getChild(ID_REFERENCE_BLOCK, EbmlUintElement);
            const isKeyframe = referenceBlock === null;

            this.processBlock(
              block,
              clusterTimecode,
              timecodeScale,
              trackNum,
              duration,
              additions ?? undefined,
              isKeyframe
            );
          }
        }
      }
    }

    // Finalize all tracks and gather samples
    for (const trackId in this.tracks) {
      this.finalizeTrack(this.tracks[trackId], timecodeScale);
    }
    this.gatherSamples();

    return elements;
  }

  private processBlock(
    block: EbmlBlockElement,
    clusterTimecode: number,
    timecodeScale: number,
    trackId: number,
    duration?: number,
    additions?: EbmlMasterElement,
    isKeyframeInferred?: boolean
  ) {
    const presentationTimeNanos =
      ((clusterTimecode + block.timecode) * timecodeScale);
    const presentationTimeSec = presentationTimeNanos / 1e9;
    const sample: Sample = {
      id: this.tracks[trackId].samples.length,
      trackId,
      offset: block.offset,
      size: block.size,
      isSync:
        block.id === ID_SIMPLE_BLOCK
          ? (block.flags & 0x80) !== 0
          : (isKeyframeInferred ?? true),
      data: block.data,
      dts: clusterTimecode + block.timecode,
      duration: duration ?? 0,
      cts: clusterTimecode + block.timecode,
      presentationTimeSec,
      presentationDurationSec: duration
        ? (duration * timecodeScale) / 1e9
        : 0,
    };

    if (additions) {
      const webmBlockAdditions: WebmBlockAddition[] = [];
      for (const more of additions.children) {
        if (elementIsOfType(more, ID_BLOCK_MORE, EbmlMasterElement)) {
          const addId = bigintToNumber(
            more.getChild(ID_BLOCK_ADD_ID, EbmlUintElement)?.value,
          );
          const addData = (
            more.getChild(ID_BLOCK_ADDITIONAL, EbmlBinaryElement)
          )?.data;
          if (addId !== undefined && addData) {
            webmBlockAdditions.push({id: addId, data: addData});
            if (addId === 4) {
              // T35
              const t35 = parseT35(addData);
              if (t35.metadataType && (t35.agtm || t35.hdr10p)) {
                const meta = getOrAddHdrMetadata(
                  this.hdrMetadata,
                  trackId,
                  t35.metadataType
                );
                meta.frames.push({
                  presentationTimeSec,
                  agtm: t35.agtm,
                  hdr10p: t35.hdr10p,
                });
              }
            }
          }
        }
      }
      if (webmBlockAdditions.length > 0) {
        sample.webmBlockAdditions = webmBlockAdditions;
      }
    }

    if (sample.isSync) this.numKeyframes++;
    this.tracks[trackId].samples.push(sample);
  }

  private gatherSamples(): void {
    this.samples = [];
    for (const trackId in this.tracks) {
      if (!Object.prototype.hasOwnProperty.call(this.tracks, trackId)) continue;
      const track = this.tracks[trackId];
      this.samples.push(...track.samples);
    }
    // Sort samples by offset to ensure they are in file order.
    this.samples.sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
  }

  private finalizeTrack(track: Track, timecodeScale: number) {
    const samples = track.samples;
    if (samples.length > 0) {
      let totalDurationSec = 0;
      for (let i = 0; i < samples.length - 1; i++) {
        const durSec =
          samples[i + 1].presentationTimeSec - samples[i].presentationTimeSec;
        samples[i].presentationDurationSec = durSec;
        samples[i].duration = samples[i + 1].dts - samples[i].dts;
        totalDurationSec += durSec;
      }

      // Determine fallback duration for the last sample.
      let lastDurationSec = 0;
      if (samples.length > 1) {
        lastDurationSec = totalDurationSec / (samples.length - 1);
      } else if (track.defaultDuration) {
        lastDurationSec = (track.defaultDuration * timecodeScale) / 1e9;
      } else {
        lastDurationSec = 1 / 30; // Assume 30fps if no other info.
      }

      const lastIdx = samples.length - 1;
      if (samples[lastIdx].duration === 0) {
        samples[lastIdx].duration = Math.round((lastDurationSec * 1e9) / timecodeScale);
      }
      if (samples[lastIdx].presentationDurationSec === 0) {
        samples[lastIdx].presentationDurationSec = lastDurationSec;
      }
    }
    track.samplesSortedByPresentationTime = [...samples].sort(
      (a, b) => a.presentationTimeSec - b.presentationTimeSec
    );
  }
}

export function parseWebm(arrayBuffer: ArrayBuffer): ParsedMedia | null {
  try {
    const webmParser = new WebmParser(arrayBuffer);
    webmParser.parse();
    const videoTrack = getFirstVideoTrack(webmParser.tracks);
    if (!videoTrack) return null;

    return {
      containerType: 'webm',
      boxes: [],
      ebmlElements: webmParser.elements,
      tracks: webmParser.tracks,
      numKeyframes: webmParser.numKeyframes,
      hdrMetadata: webmParser.hdrMetadata,
      samples: webmParser.samples,
    };
  } catch (error: unknown) {
    console.error('Error parsing WebM:', error);
    return null;
  }
}

export function parseObus(buffer: Uint8Array): OBU[] {
  try {
    const obuParser = new AV1OBUParser();
    return obuParser.parseSample(buffer);
  } catch (error: unknown) {
    console.error('Error parsing OBU:', error);
    return [];
  }
}
