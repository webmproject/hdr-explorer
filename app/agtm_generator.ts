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

import {
  AgtmMetadataType,
  getAgtmGeneratorVersion,
  kAgtmMetadataTypeNames,
  kDefaultAgtmMetadataType,
} from './agtm_metadata_types';
import {kDefaultMetadata} from './builtin_agtm';
import {AgtmMetadata, ComponentMix, Point2} from './color_helpers/agtm';
import {QuadraticBezier} from './color_helpers/bezier';
import {
  getMaxNits,
  kPrimariesRec2020,
  kTransferJz,
  kTransferPQ,
  transferFromLinear,
  transferToLinear,
} from './color_helpers/color_functions';
import {linearToLogGain, logGainToLinear} from './color_helpers/gain_curve';
import {clamp, exp2} from './color_helpers/math_helpers';
import {PiecewiseLinear} from './color_helpers/piecewise_linear';
import {ComputedStats, getPercentile, ImageStats} from './image_stats';

function jzOetfSlope(nits: number) {
  const normalized = nits / 10000;
  const epsilon = 1e-3;
  const v1 = transferFromLinear(normalized, kTransferJz);
  const v2 = transferFromLinear(normalized + epsilon, kTransferJz);
  return (v2 - v1) / epsilon;
}

/**
 * Computes the coefficients a, b, and c for the quadratic function
 * f(x) = ax^2 + bx + c based on the given constraints:
 * f(0) = minWhite
 * f(refWhite) = refWhite
 * f'(refWhite) = 1
 * f'(0) >= 0
 * @param minWhite The value of f(0).
 * @param refWhite The parameter for f(refWhite) and f'(refWhite).
 * @returns An object containing the coefficients {a, b, c} or throws an error if constraints are violated.
 */
function solveF(minWhite: number, refWhite: number): (x: number) => number {
  const c = minWhite;
  const a = minWhite / (refWhite * refWhite);
  const b = 1 - (2 * minWhite) / refWhite;
  // Check the inequality constraint: f'(0) >= 0, which means b >= 0.
  if (b < 0) {
    throw new Error(
      `The constraint f'(0) >= 0 is violated. f'(0) (which is b) must be >= 0, but it is ${b}. This requires 1 - 2 * minWhite / refWhite >= 0.`,
    );
  }
  return (x) => a * x * x + b * x + c;
}

export function getHdrReferenceWhite(stats: ComputedStats): number {
  const percentile = 0.8;
  let luma = getPercentile(percentile, stats.bins, 3);

  // Cap the reference white to 1.5 brighter than the median.
  const median = getPercentile(0.5, stats.bins, 3);
  const brighterMedian =
    transferToLinear(
      transferFromLinear(median / 10000, kTransferJz) * 1.5,
      kTransferJz,
    ) * 10000;
  luma = Math.min(luma, brighterMedian);

  // Also cap so that the content headroom is at most halved (in log space).
  const kStandardRefWhite = 203;
  const currentHeadroomLinear = getConservativeBaselineHeadroomLinear(
    stats,
    kStandardRefWhite,
  );
  // This is the same as Math.pow(currentHeadroomLinear, 1 / 2) (i.e. sqrt).
  const minNewHeadroomLinear = exp2(Math.log2(currentHeadroomLinear) / 2);
  const contentMax = currentHeadroomLinear * kStandardRefWhite;
  const maxRefWhiteForMinHeadroom = contentMax / minNewHeadroomLinear;
  luma = Math.min(luma, maxRefWhiteForMinHeadroom);

  // Also cap to an absolute maximum reference white.
  const kMaxRefWhite = 1000;
  luma = Math.min(luma, kMaxRefWhite);

  // TODO: maybe don't darken too much dark images that have a lot of highlights.

  // If luma is below standard white (i.e. we are brightening the image),
  // use a quadratic function to slowly decrease down to kMinRefWhite.
  if (luma < kStandardRefWhite) {
    // kMinRefWhite must be at most kStandardRefWhite/2 otherwise the quadratic
    // function would not be monotonic for x > 0.
    const kMinRefWhite = 100;
    const f = solveF(kMinRefWhite, kStandardRefWhite);
    luma = f(luma);
  }

  return luma;
}

const MAX_BASELINE_HEADROOM_LINEAR = exp2(6); // Max allowed in the spec.

/**
 * Returns an underestimate of the baseline headroom (linear), used for AGTM
 * metadata that would otherwise be too dark if the real max value (influenced
 * by outliers) was used.
 */
export function getConservativeBaselineHeadroomLinear(
  stats: ComputedStats,
  referenceWhite: number,
): number {
  // Do not use the max value, as it is not very sensitive to outliers. E.g. the
  // Galaxy Fold 5 produces PQ videos with a few pixels at 10000 nits.
  const percentile = 0.995;
  return clamp(
    getPercentile(percentile, stats.bins, 3) / referenceWhite,
    1,
    15,
  );
}

/**
 * Returns the real baseline headroom, used for histogram based AGTM metadata
 * that is robust enough to handle outliers.
 */
function getRealBaselineHeadroomLinear(
  stats: ComputedStats,
  referenceWhite: number,
): number {
  return clamp(
    stats.maxMaxRgb / referenceWhite,
    1,
    MAX_BASELINE_HEADROOM_LINEAR,
  );
}

const kAllowBoosting = false;

/** Scales AGTM metadata based on the maximum pixel values in the image. */
function adaptMetadataWithStats(
  metadata: AgtmMetadata,
  stats: ComputedStats,
  referenceWhiteOverride?: number,
  baselineHeadroomLinearOverride?: number,
): AgtmMetadata {
  const referenceWhite = referenceWhiteOverride ?? getHdrReferenceWhite(stats);
  const baselineHeadroomLinear =
    baselineHeadroomLinearOverride ??
    getConservativeBaselineHeadroomLinear(stats, referenceWhite);
  const baselineHeadroom = Math.log2(baselineHeadroomLinear);

  const newMetadata = structuredClone(metadata);
  newMetadata.hdr_reference_white = referenceWhite;
  newMetadata.baseline_hdr_headroom = baselineHeadroom;

  const xScale = baselineHeadroomLinear / exp2(metadata.baseline_hdr_headroom);
  const headroomScale = baselineHeadroom / metadata.baseline_hdr_headroom;
  for (let i = 0; i < newMetadata.altr.length; ++i) {
    const altr = newMetadata.altr[i];
    const oldAltrHeadroom = altr.headroom;
    altr.headroom *= headroomScale;
    const yScale = exp2(altr.headroom) / exp2(oldAltrHeadroom);
    const slopeScale = yScale / xScale;

    for (const point of altr.curve) {
      if (point.x === 16) continue; // Skip the y=x line.

      const linear = logGainToLinear(point);

      linear.x *= xScale;
      linear.y *= yScale;
      if (linear.m !== undefined) {
        linear.m *= slopeScale;
      }
      if (!kAllowBoosting && linear.y > linear.x) {
        linear.y = linear.x;
        linear.m = 1;
      }

      const logGain = linearToLogGain(linear);
      point.x = logGain.x;
      point.y = logGain.y;
      point.m = logGain.m;
    }

    if (headroomScale === 0) {
      newMetadata.altr.splice(1, newMetadata.altr.length - 1);
      break;
    }
  }
  return newMetadata;
}

interface ToneMappingOperator {
  evaluate(x: number): number;
}

// Apple's Reference White Tone Mapping Operator.
class Rwtmo {
  readonly bezier;

  constructor(
    private readonly contentHeadroomLinear: number,
    private readonly targetHeadroomLinear: number,
    private readonly outputExposure: number,
  ) {
    const k = 0.65;
    const xKnee = 1;
    const yKnee = outputExposure;
    const xMax = contentHeadroomLinear;
    const yMax = targetHeadroomLinear;
    const xMid = (1 - k) * xKnee + k * ((xKnee * yMax) / yKnee);
    const yMid = (1 - k) * yKnee + k * yMax;
    this.bezier = new QuadraticBezier([
      {x: xKnee, y: yKnee},
      {x: xMid, y: yMid},
      {x: xMax, y: yMax},
    ]);
  }

  evaluate(x: number) {
    // Linear segmement (beginning of the curve).
    const conditionLinear =
      x <= 1 ||
      this.contentHeadroomLinear * this.outputExposure <=
        this.targetHeadroomLinear;
    if (conditionLinear) {
      return this.outputExposure * x;
    }

    // Clip segment (end of the curve).
    const conditionClip = x >= this.contentHeadroomLinear;
    if (conditionClip) {
      return this.targetHeadroomLinear;
    }

    // Bezier segment (middle of the curve).
    return this.bezier.evaluate(x);
  }
}

function toGainCurve(xValues: number[], tmo: ToneMappingOperator): Point2[] {
  const epsilon = 1e-5;
  const res: Point2[] = [];
  for (let i = 0; i < xValues.length; ++i) {
    const x = xValues[i];
    const y = Math.log2(tmo.evaluate(x) / x);
    const y2 = Math.log2(tmo.evaluate(x + epsilon) / (x + epsilon));
    const m = (y2 - y) / epsilon;
    res.push({x, y, m});
  }
  return res;
}

/**
 * Generates control points for the tone mapping curve, with a power function
 * to space points more densely at the beginning.
 */
function generateControlPointsX(
  numPoints: number,
  power: number,
  start: number,
  end: number,
): number[] {
  const controlPointsX = [];
  for (let i = 0; i < numPoints; ++i) {
    const t = i / (numPoints - 1);
    const scaledT = Math.pow(t, power);
    const x = start + scaledT * (end - start);
    controlPointsX.push(x);
  }
  return controlPointsX;
}

/**
 * Generates AGTM metadata from a tone mapping operator factory.
 * This function encapsulates the common logic of creating multiple curves for
 * different target headrooms.
 */
function generateAgtmFromTmo(
  contentHeadroomLinear: number,
  referenceWhite: number,
  tmoFactory: (targetHeadroomLinear: number) => ToneMappingOperator,
  controlPointsX: number[],
): AgtmMetadata {
  const kNumCurves = 3;

  const agtm: AgtmMetadata = {
    hdr_reference_white: referenceWhite,
    gain_application_space_primaries: kPrimariesRec2020,
    baseline_hdr_headroom: Math.log2(contentHeadroomLinear),
    altr: [],
  };

  for (let i = 0; i < kNumCurves; ++i) {
    const targetHeadroomLinear =
      1 + (i * (contentHeadroomLinear - 1)) / kNumCurves;
    const tmo = tmoFactory(targetHeadroomLinear);
    agtm.altr.push({
      headroom: Math.log2(targetHeadroomLinear),
      mix: {rgb: [0, 0, 0], max: 1, min: 0, channel: 0},
      curve: toGainCurve(controlPointsX, tmo),
    });
  }
  return agtm;
}

function computeRwtmoTargetHeadroomLinear(
  contentHeadroomLinear: number,
  curveIndex: number,
  numCurves: number,
): number {
  if (numCurves !== 2) {
    throw new Error(
      `Unexpected number of curves: ${numCurves}; RWTMO only supports 2 curves.`,
    );
  }
  if (curveIndex === 0) {
    return 1;
  }
  if (curveIndex === 1) {
    return exp2(
      Math.log2(8 / 3) *
        Math.min(Math.log2(contentHeadroomLinear) / Math.log2(1000 / 203), 1),
    );
  }
  return contentHeadroomLinear;
}

/**
 * Computes the value that the diffuse white should be mapped to for the given
 * curve (assuming curve index 0 is for target headroom=1, and curve
 * index numCurves-1 is for target headroom=contentHeadroomLinear)
 */
function computeRwtmoOutputExposure(
  contentHeadroomLinear: number,
  curveIndex: number,
  numCurves: number,
): number {
  return (
    1 -
    ((numCurves - curveIndex - 1) / numCurves) *
      Math.min(Math.log2(contentHeadroomLinear) / Math.log2(1000 / 203), 1)
  );
}

/**
 * Genarates AGTM metadata for Apple's Reference White Tone Mapping Operator
 * based on the binary format in SMPTE ST 2094-50.
 */
function generateRwtmo(
  stats: ComputedStats,
  referenceWhite = 203,
  baselineHeadroomLinearOverride?: number,
): AgtmMetadata {
  const contentHeadroomLinear =
    baselineHeadroomLinearOverride ??
    getConservativeBaselineHeadroomLinear(stats, referenceWhite);

  const kNumControlPoints = 8;
  const controlPointsT = generateControlPointsX(
    kNumControlPoints,
    /*power=*/ 1.0,
    /*start=*/ 0,
    /*end=*/ 1,
  );

  const agtm: AgtmMetadata = {
    hdr_reference_white: referenceWhite,
    gain_application_space_primaries: kPrimariesRec2020,
    baseline_hdr_headroom: Math.log2(contentHeadroomLinear),
    altr: [],
  };

  const kNumCurves = 2;
  for (let i = 0; i < kNumCurves; ++i) {
    const targetHeadroomLinear = computeRwtmoTargetHeadroomLinear(
      contentHeadroomLinear,
      i,
      kNumCurves,
    );
    const outputExposure = computeRwtmoOutputExposure(
      contentHeadroomLinear,
      i,
      kNumCurves,
    );
    const tmo = new Rwtmo(
      contentHeadroomLinear,
      targetHeadroomLinear,
      outputExposure,
    );
    const bezier = tmo.bezier;

    agtm.altr.push({
      headroom: Math.log2(targetHeadroomLinear),
      mix: {rgb: [0, 0, 0], max: 1, min: 0, channel: 0},
      curve: controlPointsT.map((t) => {
        const x = bezier.getX(t);
        const y = bezier.getY(t);
        const m = bezier.getM(t);
        return {x, y: Math.log2(y / x), m: (x * m - y) / (Math.log(2) * x * y)};
      }),
    });
  }

  return agtm;
}

type HistogramBaseTmoFactory = (
  contentHeadroomLinear: number,
  targetHeadroomLinear: number,
  curveIndex: number,
  numCurves: number,
) => ToneMappingOperator;

/**
 * Generates AGTM metadata from a given base tone mapping operator, adjusting
 * the curve based on the histogram of the input image.
 * `baseWeight` determines how much to adjust the base curve based on the
 * histogram. A smaller weight means that the curve is more similar to
 * the base curve. A higher weight (which can be above 1) changes it more,
 * and eventually makes it tend towards a simple clipping curve
 * (linear y=x up to targetHeadroomLinear then clip).
 */
function generateHistogramBased(
  stats: ComputedStats,
  baseTmoFactory: HistogramBaseTmoFactory,
  isRwtmo: boolean,
  baseWeight: number,
  referenceWhiteOverride?: number,
  baselineHeadroomLinearOverride?: number,
): AgtmMetadata {
  const referenceWhite = referenceWhiteOverride ?? getHdrReferenceWhite(stats);
  const contentHeadroomLinear =
    baselineHeadroomLinearOverride ??
    getRealBaselineHeadroomLinear(stats, referenceWhite);

  const agtm: AgtmMetadata = {
    hdr_reference_white: referenceWhite,
    gain_application_space_primaries: kPrimariesRec2020,
    baseline_hdr_headroom: Math.log2(contentHeadroomLinear),
    altr: [],
  };

  // RWTMO only supports 2 curves.
  // Use more curves for other types for now.
  const numCurves = isRwtmo ? 2 : 3;

  // Keep only the bins where binMax < contentHeadroomLinear.
  const bins = stats.bins.filter(
    (bin) => bin.binMax / referenceWhite < contentHeadroomLinear,
  );

  // Knee point: do not adjust bins smaller than this (just keep the base tone
  // mapping).
  const kMinXToAdjust = 0.05; // SDR relative value

  // Average 'freq' accross all adjusted bins.
  // Note that this is influenced by the size of the buckets which is not
  // uniform, see kGamma in image_stats.ts.
  const c = 3; // luma channel
  const adjustedBins = bins.filter(
    (bin) => bin.binMax / referenceWhite > kMinXToAdjust,
  );
  const avgFreq = adjustedBins.length > 0
    ? adjustedBins.map((bin) => bin.freq[c]).reduce((a, b) => a + b, 0) /
      adjustedBins.length
    : 0;

  // Half luma and half maxRGB.
  // Combines the advantages of luma (tone mapping based on actual luminance)
  // with that of maxRGB (preventing out of gamut colors).
  const mix: ComponentMix = {
    rgb: [0.2627 * 0.5, 0.678 * 0.5, 0.0593 * 0.5],
    max: 0.5,
    min: 0,
    channel: 0,
  };

  for (let iCurve = 0; iCurve < numCurves; ++iCurve) {
    const targetHeadroomLinear = isRwtmo
      ? computeRwtmoTargetHeadroomLinear(
          contentHeadroomLinear,
          iCurve,
          numCurves,
        )
      : exp2((iCurve * Math.log2(contentHeadroomLinear)) / numCurves);

    const baseCurve = baseTmoFactory(
      contentHeadroomLinear,
      targetHeadroomLinear,
      iCurve,
      numCurves,
    );

    // Create one control point per bin.
    const points: Point2[] = [{x: 0, y: 0}];
    let cumulatedChange = 0;
    for (const bin of bins) {
      const binMax = bin.binMax / referenceWhite;
      const x = binMax;

      // At low nits, a small change in nits is very perceptible, so we should
      // make smaller changes. Use the slope of the Jz transfer curve (which is
      // supposed to be perceptually linear) to guide the amount of change.
      const slope = jzOetfSlope(x * referenceWhite);
      // Lower slope => larger change.
      const slopeDerivedWeight = clamp(10 / slope, 0, 10); // Empirical formula.
      const weight = baseWeight * slopeDerivedWeight;

      const change = binMax > kMinXToAdjust ? bin.freq[c] - avgFreq : 0;
      cumulatedChange += change;

      const baseY = baseCurve.evaluate(x);
      let y = baseY + cumulatedChange * weight;
      // Make sure the curve is monotonic.
      let minY = 0;
      if (points.length > 0) {
        const kMinSlope = 1e-3;
        const prevPoint = points[points.length - 1];
        minY = prevPoint.y + kMinSlope * (x - prevPoint.x);
      }
      if (y < minY) {
        y = minY;
        // Set cumulatedChange so that yMin = baseY + cumulatedChange * weight
        cumulatedChange = weight > 1e-6 ? (minY - baseY) / weight : 0;
      }

      points.push({x, y});
    }
    const maxY = points[points.length - 1].y;
    if (maxY > targetHeadroomLinear) {
      // Rescale the curve to make sure it does not go over the targetHeadroomLinear.
      // The rescaling is done in PQ space.
      const linearToPq = (v: number) =>
        transferFromLinear((v * referenceWhite) / 10000, kTransferPQ);
      const pqToLinear = (v: number) =>
        (transferToLinear(v, kTransferPQ) * 10000) / referenceWhite;

      const pqMaxY = linearToPq(maxY);
      const pqtargetHeadroomLinear = linearToPq(targetHeadroomLinear);
      const pqScale = pqMaxY > 0 ? pqtargetHeadroomLinear / pqMaxY : 1;

      for (let i = 0; i < points.length; ++i) {
        const pqY = linearToPq(points[i].y);
        const scaledPqY = pqY * pqScale;
        points[i].y = pqToLinear(scaledPqY);
      }
    }
    // Make sure the curve doesn't go above the y = x line.
    for (let i = 0; i < points.length; ++i) {
      points[i].y = Math.min(points[i].y, points[i].x);
    }

    points.push({x: contentHeadroomLinear, y: targetHeadroomLinear});

    const tmo = new PiecewiseLinear(points);

    // TODO(maryla): simplify the curve to have fewer points.
    const kNumControlPoints = 16;
    // Change to points.map((point) => point.x) to see the curve as it was built.
    const controlPointsX = generateControlPointsX(
      kNumControlPoints,
      /*power=*/ 3.0,
      /*start=*/ 0.01,
      /*end=*/ contentHeadroomLinear,
    );

    agtm.altr.push({
      headroom: Math.log2(targetHeadroomLinear),
      mix,
      curve: toGainCurve(controlPointsX, tmo),
    });
  }

  return agtm;
}

// Chrome's Tone Mapping Operator. Based on:
// https://docs.google.com/document/d/17T2ek1i2R7tXdfHCnM-i5n6__RoYe0JyMfKmTEjoGR8/edit?tab=t.0
class ChromeToneMapper implements ToneMappingOperator {
  constructor(
    private readonly contentHeadroomLinear: number,
    private readonly targetHeadroomLinear: number,
  ) {}

  evaluate(x: number): number {
    if (this.targetHeadroomLinear >= this.contentHeadroomLinear) {
      return x;
    }

    const numerator =
      1 +
      (this.targetHeadroomLinear / Math.pow(this.contentHeadroomLinear, 2)) * x;
    const denominator = 1 + (1 / this.targetHeadroomLinear) * x;
    return x * (numerator / denominator);
  }
}

function generateChrome(
  stats: ComputedStats,
  referenceWhiteOverride?: number,
  baselineHeadroomLinearOverride?: number,
): AgtmMetadata {
  const referenceWhite = referenceWhiteOverride ?? 203;
  const contentHeadroomLinear =
    baselineHeadroomLinearOverride ??
    getConservativeBaselineHeadroomLinear(stats, referenceWhite);

  const tmoFactory = (targetHeadroomLinear: number) => {
    return new ChromeToneMapper(contentHeadroomLinear, targetHeadroomLinear);
  };

  const kNumControlPoints = 6;
  const controlPointsX = generateControlPointsX(
    kNumControlPoints,
    /*power=*/ 2.0,
    /*start=*/ 0.01,
    /*end=*/ contentHeadroomLinear,
  );

  return generateAgtmFromTmo(
    contentHeadroomLinear,
    referenceWhite,
    tmoFactory,
    controlPointsX,
  );
}

// Tone Mapping Operator for linear scaling in linear space.
class LinearToneMapper implements ToneMappingOperator {
  constructor(
    private readonly contentHeadroomLinear: number,
    private readonly targetHeadroomLinear: number,
  ) {}

  evaluate(x: number): number {
    if (this.targetHeadroomLinear >= this.contentHeadroomLinear) {
      return x;
    }
    return x * (this.targetHeadroomLinear / this.contentHeadroomLinear);
  }
}

// Tone Mapping Operator for linear scaling in PQ space.
class LinearPqToneMapper implements ToneMappingOperator {
  constructor(
    private readonly referenceWhite: number,
    private readonly contentHeadroomLinear: number,
    private readonly targetHeadroomLinear: number,
  ) {}

  private toPq(x: number): number {
    return transferFromLinear((x * this.referenceWhite) / 10000, kTransferPQ);
  }

  private fromPq(x: number): number {
    return (transferToLinear(x, kTransferPQ) * 10000) / this.referenceWhite;
  }

  evaluate(x: number): number {
    if (this.targetHeadroomLinear >= this.contentHeadroomLinear) {
      return x;
    }

    const pqContent = this.toPq(this.contentHeadroomLinear);
    const pqTarget = this.toPq(this.targetHeadroomLinear);
    const pqX = this.toPq(x);

    // Linear scaling in PQ space.
    const scaledPq = pqX * (pqTarget / pqContent);
    return this.fromPq(scaledPq);
  }
}

function generateLinear(
  stats: ComputedStats,
  referenceWhiteOverride?: number,
  baselineHeadroomLinearOverride?: number,
  inPqSpace = false,
): AgtmMetadata {
  const referenceWhite = referenceWhiteOverride ?? getHdrReferenceWhite(stats);
  const contentHeadroomLinear =
    baselineHeadroomLinearOverride ??
    getRealBaselineHeadroomLinear(stats, referenceWhite);

  const tmoFactory = (targetHeadroomLinear: number) => {
    return inPqSpace
      ? new LinearPqToneMapper(
          referenceWhite,
          contentHeadroomLinear,
          targetHeadroomLinear,
        )
      : new LinearToneMapper(contentHeadroomLinear, targetHeadroomLinear);
  };

  const kNumControlPoints = 12;
  const controlPointsX = generateControlPointsX(
    kNumControlPoints,
    /*power=*/ 2.0,
    /*start=*/ 0.01,
    /*end=*/ contentHeadroomLinear,
  );

  return generateAgtmFromTmo(
    contentHeadroomLinear,
    referenceWhite,
    tmoFactory,
    controlPointsX,
  );
}

export function getStatsForAgtm(
  type: AgtmMetadataType | 'fromfile' | 'custom',
  imageStats: ImageStats,
  contentTransfer: number,
  fullRange = false,
) {
  const xScalingFunc = ImageStats.kDefaultScalingFunc;
  const xScalingInv = ImageStats.kDefaultScalingInv;
  const numBins = 100;
  return imageStats.getStats(
    fullRange ? getMaxNits(contentTransfer) : null,
    xScalingFunc,
    xScalingInv,
    numBins,
  );
}

export async function getAgtm(
  type: AgtmMetadataType,
  contentTransfer: number,
  stats?: ComputedStats,
  hdrReferenceWhite?: number,
  baselineHeadroomLinear?: number,
): Promise<AgtmMetadata> {
  // Types that don't require stats.
  switch (type) {
    case AgtmMetadataType.DEFAULT: {
      const metadata = structuredClone(kDefaultMetadata);
      if (hdrReferenceWhite !== undefined) {
        metadata.hdr_reference_white = hdrReferenceWhite;
      }
      if (baselineHeadroomLinear !== undefined) {
        metadata.baseline_hdr_headroom = Math.log2(baselineHeadroomLinear);
      }
      return metadata;
    }
    default:
      break;
  }
  if (!stats) {
    throw new Error('Stats are required for this metadata type.');
  }
  switch (type) {
    case AgtmMetadataType.DEFAULT_ADJUSTED:
      return adaptMetadataWithStats(
        kDefaultMetadata,
        stats,
        hdrReferenceWhite,
        baselineHeadroomLinear,
      );
    case AgtmMetadataType.RWTMO:
      return generateRwtmo(stats, hdrReferenceWhite, baselineHeadroomLinear);
    case AgtmMetadataType.RWTMO_WHITE:
      return generateRwtmo(
        stats,
        hdrReferenceWhite ?? getHdrReferenceWhite(stats),
        baselineHeadroomLinear,
      );
    case AgtmMetadataType.HISTOGRAM_BASED: {
      const linearFactory: HistogramBaseTmoFactory = (chL, thL, i, n) =>
        new LinearToneMapper(chL, thL);
      return generateHistogramBased(
        stats,
        linearFactory,
        /*isRwtmo=*/ false,
        /*weight=*/ 0.5,
        hdrReferenceWhite,
        baselineHeadroomLinear,
      );
    }
    case AgtmMetadataType.HISTOGRAM_BASED_RWTMO: {
      const rwtmoFactory: HistogramBaseTmoFactory = (chL, thL, i, n) => {
        const outputExposure = computeRwtmoOutputExposure(chL, i, n);
        return new Rwtmo(chL, thL, outputExposure);
      };
      return generateHistogramBased(
        stats,
        rwtmoFactory,
        /*isRwtmo=*/ true,
        /*weight=*/ 0.1,
        hdrReferenceWhite,
        baselineHeadroomLinear,
      );
    }
    case AgtmMetadataType.HISTOGRAM_BASED_CHROME:
    case AgtmMetadataType.HISTOGRAM_BASED_CHROME_203: {
      const chromeReferenceWhite =
        type === AgtmMetadataType.HISTOGRAM_BASED_CHROME_203
          ? (hdrReferenceWhite ?? 203)
          : hdrReferenceWhite;
      const chromeFactory: HistogramBaseTmoFactory = (chL, thL, i, n) =>
        new ChromeToneMapper(chL, thL);
      return generateHistogramBased(
        stats,
        chromeFactory,
        /*isRwtmo=*/ false,
        /*weight=*/ 0.1,
        chromeReferenceWhite,
        baselineHeadroomLinear,
      );
    }
    case AgtmMetadataType.CHROME:
      return generateChrome(stats, undefined, baselineHeadroomLinear);
    case AgtmMetadataType.CHROME_WHITE:
      return generateChrome(
        stats,
        hdrReferenceWhite ?? getHdrReferenceWhite(stats),
        baselineHeadroomLinear,
      );
    case AgtmMetadataType.LINEAR:
      return generateLinear(stats, hdrReferenceWhite, baselineHeadroomLinear);
    case AgtmMetadataType.LINEAR_PQ:
      return generateLinear(
        stats,
        hdrReferenceWhite,
        baselineHeadroomLinear,
        true,
      );
    default: {
      console.error('Unsupported AGTM metadata type: ', type);
      return structuredClone(kDefaultMetadata);
    }
  }
}

/**
 * Returns true if the metadata type requires stats to be computed.
 */
export function needsStats(metadataType: AgtmMetadataType): boolean {
  return !(
    metadataType === AgtmMetadataType.DEFAULT ||
    metadataType.endsWith('static') ||
    metadataType.startsWith('gain_map')
  );
}
