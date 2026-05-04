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
  CHROMATICITIES_REC2020,
  getChromaticities,
  kPrimariesRec2020
} from './color_helpers/color_functions';

/**
 * Converts an AGTM metadata object to a JSON string.
 */
export function metadataToJson(metadata: AgtmMetadata): string {
  return standardMetadataToJsonImpl(mapToStandardFormat(metadata));
}

/**
 * Converts a list of AGTM metadata objects to a JSON string.
 */
export function metadataListToJson(
  metadataList: Array<AgtmMetadata | null>,
): string {
  const mappedList = metadataList.map((m) =>
    m ? mapToStandardFormat(m) : null,
  );
  return standardMetadataToJsonImpl(mappedList);
}

declare interface StandardAgtmFormat {
  hdrReferenceWhite: number;
  headroomAdaptiveToneMap?: {
    baselineHdrHeadroom: number;
    gainApplicationChromaticities: number[];
    alternateImages: Array<{
      hdrHeadroom: number;
      colorGainFunction: {
        componentMix: {
          red?: number;
          green?: number;
          blue?: number;
          max?: number;
          min?: number;
          component?: number;
        };
        gainCurve: {
          controlPoints: Array<{
            x: number;
            y: number;
            m: number;
          }>;
        };
      };
    }>;
  };
}

function mapToStandardFormat(metadata: AgtmMetadata): StandardAgtmFormat {
  const standard: StandardAgtmFormat = {
    hdrReferenceWhite: metadata.hdr_reference_white,
  };

  const chromaticities = metadata.gain_application_space_chromaticities ??
      getChromaticities(metadata.gain_application_space_primaries ??
                        kPrimariesRec2020);
  standard.headroomAdaptiveToneMap = {
    baselineHdrHeadroom: metadata.baseline_hdr_headroom,
    gainApplicationChromaticities: chromaticities,
    alternateImages: metadata.altr.map((altr) => ({
      hdrHeadroom: altr.headroom,
      colorGainFunction: {
        componentMix: {
          red: altr.mix.rgb[0],
          green: altr.mix.rgb[1],
          blue: altr.mix.rgb[2],
          max: altr.mix.max,
          min: altr.mix.min,
          component: altr.mix.channel,
        },
        gainCurve: {
          controlPoints: altr.curve.map((cp) => ({
            x: cp.x,
            y: cp.y,
            m: cp.m ?? 0,
          })),
        },
      },
    })),
  };

  return standard;
}

function standardMetadataToJsonImpl(
  metadata: StandardAgtmFormat | Array<StandardAgtmFormat | null>,
): string {
  const kNumDecimalPlaces = 5; // limit precision of floats
  return (
    JSON.stringify(
      metadata,
      (key, value) => {
        if (typeof value === 'number') {
          return Number(value.toFixed(kNumDecimalPlaces));
        }
        return value;
      },
      2,
    )
      // Make each curve point object a single line.
      .replace(
        /(\s*){\n\s*"x": ([\d\.\-]+),\n\s*"y": ([\d\.\-]+),\n\s*"m": ([\d\.\-]+)\n\s*}/g,
        (match, indent: string, x: string, y: string, m: string) =>
          `${indent}{ "x": ${x}, "y": ${y}, "m": ${m} }`,
      )
      // Make the componentMix object more compact.
      .replace(
        /(componentMix": \{)([^}]+)/g,
        (match, a: string, b: string) => a + b.replace(/\s+/g, ' '),
      )
      // Make the gainApplicationChromaticities array more compact.
      .replace(
        /(gainApplicationChromaticities": \[)([^\]]+)(\])/g,
        (match, a: string, b: string, c: string) =>
          a + b.replace(/\s+/g, ' ') + c,
      )
  );
}

type RecursivePartial<T> = T extends object
  ? T extends Array<infer U>
    ? Array<RecursivePartial<U>>
    : {[P in keyof T]?: RecursivePartial<T[P]>}
  : T;

/**
 * Converts a JSON string to an AGTM metadata object.
 * Missing fields are set to default values.
 */
export function jsonToMetadata(json: string): AgtmMetadata {
  const parsedJson = JSON.parse(json) as RecursivePartial<StandardAgtmFormat> &
    RecursivePartial<AgtmMetadata>;
  if (
    parsedJson.hdrReferenceWhite !== undefined ||
    parsedJson.headroomAdaptiveToneMap !== undefined
  ) {
    return standardJsonToMetadata(parsedJson);
  }
  return jsonToMetadataOld(parsedJson);
}

function standardJsonToMetadata(
  parsedJson: RecursivePartial<StandardAgtmFormat>,
): AgtmMetadata {
  const metadata: AgtmMetadata = {
    hdr_reference_white: parsedJson.hdrReferenceWhite ?? 203,
    baseline_hdr_headroom: 0,
    altr: [],
  };

  const atm = parsedJson.headroomAdaptiveToneMap;
  if (atm) {
    metadata.baseline_hdr_headroom = atm.baselineHdrHeadroom ?? 0;
    metadata.gain_application_space_chromaticities =
      atm.gainApplicationChromaticities ?? CHROMATICITIES_REC2020;

    for (const altImage of atm.alternateImages ?? []) {
      const rule = {
        headroom: altImage.hdrHeadroom ?? 0,
        mix: {
          max: 0,
          min: 0,
          channel: 0,
          rgb: [0, 0, 0] as [number, number, number],
        },
        curve: [] as Array<{x: number; y: number; m: number}>,
      };

      const cgf = altImage.colorGainFunction;
      if (cgf) {
        if (cgf.componentMix) {
          rule.mix = {
            max: cgf.componentMix.max ?? 0,
            min: cgf.componentMix.min ?? 0,
            channel: cgf.componentMix.component ?? 0,
            rgb: [
              cgf.componentMix.red ?? 0,
              cgf.componentMix.green ?? 0,
              cgf.componentMix.blue ?? 0,
            ],
          };
        }
        if (cgf.gainCurve && cgf.gainCurve.controlPoints) {
          for (const cp of cgf.gainCurve.controlPoints) {
            rule.curve.push({
              x: cp.x ?? 0,
              y: cp.y ?? 0,
              m: cp.m ?? 0,
            });
          }
        }
      }
      metadata.altr.push(rule);
    }
  }

  return metadata;
}

function jsonToMetadataOld(
  parsedJson: RecursivePartial<AgtmMetadata>,
): AgtmMetadata {
  const metadata: AgtmMetadata = {
    hdr_reference_white: parsedJson.hdr_reference_white ?? 203,
    gain_application_space_primaries:
      (parsedJson.gain_application_space_primaries as number | undefined) ??
      (parsedJson.gain_application_space_chromaticities === undefined
        ? kPrimariesRec2020 // Defaults to Rec. 2020 primaries if neither is provided.
        : undefined),
    gain_application_space_chromaticities:
      parsedJson.gain_application_space_chromaticities as number[] | undefined,
    baseline_hdr_headroom: parsedJson.baseline_hdr_headroom ?? 0,
    altr: [],
  };
  for (const altr of parsedJson.altr ?? []) {
    if (!altr) continue;
    metadata.altr.push({
      headroom: altr.headroom ?? 0,
      mix: {max: 1, min: 0, channel: 0, rgb: [0, 0, 0]},
      curve: [],
    });
    if (altr.mix) {
      metadata.altr[metadata.altr.length - 1].mix = {
        max: altr.mix.max ?? 0,
        min: altr.mix.min ?? 0,
        channel: altr.mix.channel ?? 0,
        rgb: [
          altr.mix.rgb?.[0] ?? 0,
          altr.mix.rgb?.[1] ?? 0,
          altr.mix.rgb?.[2] ?? 0,
        ],
      };
    }
    for (const curve of altr.curve ?? []) {
      if (!curve) continue;
      metadata.altr[metadata.altr.length - 1].curve.push({
        x: curve.x ?? 0,
        y: curve.y ?? 0,
        m: curve.m ?? 0,
      });
    }
  }

  return metadata;
}
