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

export const AgtmMetadataType = {
  DEFAULT: 'default',
  DEFAULT_ADJUSTED: 'default_adaptive',
  RWTMO: 'rwtmo',
  RWTMO_WHITE: 'rwtmo_white',
  CHROME: 'chrome',
  CHROME_WHITE: 'chrome_white',
  LINEAR: 'linear',
  LINEAR_PQ: 'linear_pq',
  HISTOGRAM_BASED_RWTMO: 'histogram_based_rwtmo',
  HISTOGRAM_BASED_CHROME: 'histogram_based_chrome',
  HISTOGRAM_BASED_CHROME_203: 'histogram_based_chrome_203',
  HISTOGRAM_BASED: 'histogram_based',
} as const;

export type AgtmMetadataType =
  (typeof AgtmMetadataType)[keyof typeof AgtmMetadataType];

/**
 * The version of the AGTM generator for each metadata type.
 * The version should be incremented every time the generator changes in a way
 * that affects the rendered image.
 */
const AGTM_GENERATOR_VERSIONS: Record<AgtmMetadataType, string> = {
  [AgtmMetadataType.DEFAULT]: 'v1.0.0',
  [AgtmMetadataType.DEFAULT_ADJUSTED]: 'v1.1.0',
  [AgtmMetadataType.RWTMO]: 'v1.0.0',
  [AgtmMetadataType.RWTMO_WHITE]: 'v1.1.0',
  [AgtmMetadataType.CHROME]: 'v1.0.0',
  [AgtmMetadataType.CHROME_WHITE]: 'v1.1.0',
  [AgtmMetadataType.LINEAR]: 'v1.1.0',
  [AgtmMetadataType.LINEAR_PQ]: 'v1.1.0',
  [AgtmMetadataType.HISTOGRAM_BASED_RWTMO]: 'v1.1.0',
  [AgtmMetadataType.HISTOGRAM_BASED_CHROME]: 'v1.1.0',
  [AgtmMetadataType.HISTOGRAM_BASED_CHROME_203]: 'v1.1.0',
  [AgtmMetadataType.HISTOGRAM_BASED]: 'v1.1.0',
};

export function getAgtmGeneratorVersion(type: AgtmMetadataType): string {
  // The Record type ensures at compile-time that all types are in the map.
  return AGTM_GENERATOR_VERSIONS[type];
}

export const kDefaultAgtmMetadataType = AgtmMetadataType.HISTOGRAM_BASED_CHROME;

export const kAgtmMetadataTypeNames: Record<AgtmMetadataType, string> = {
  [AgtmMetadataType.DEFAULT]: 'Simple static metadata',
  [AgtmMetadataType.DEFAULT_ADJUSTED]:
    'Simple with max CLL and diffuse white adjustment',
  [AgtmMetadataType.RWTMO]: 'Apple RWTMO',
  [AgtmMetadataType.RWTMO_WHITE]: 'Apple RWTMO with diffuse white adjustment',
  [AgtmMetadataType.CHROME]: 'Chrome Reinhard',
  [AgtmMetadataType.CHROME_WHITE]:
    'Chrome Reinhard with diffuse white adjustment',
  [AgtmMetadataType.LINEAR]: 'Naive linear',
  [AgtmMetadataType.LINEAR_PQ]: 'Linear in PQ space',
  [AgtmMetadataType.HISTOGRAM_BASED_RWTMO]: 'Histogram adjusted RWTMO',
  [AgtmMetadataType.HISTOGRAM_BASED_CHROME]:
    'Histogram adjusted Chrome Reinhard',
  [AgtmMetadataType.HISTOGRAM_BASED_CHROME_203]:
    'Histogram adjusted Chrome Reinhard White=203',
  [AgtmMetadataType.HISTOGRAM_BASED]: 'Histogram adjusted linear',
};
