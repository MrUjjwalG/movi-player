/*
 * SoundTouch JS v0.3.0 audio processing library
 * Copyright (c) Olli Parviainen
 * Copyright (c) Ryan Berdeen
 * Copyright (c) Jakub Fiala
 * Copyright (c) Steve 'Cutter' Blades
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 */

class FifoSampleBuffer {
  private _vector: Float32Array;
  private _position: number;
  private _frameCount: number;

  constructor() {
    this._vector = new Float32Array();
    this._position = 0;
    this._frameCount = 0;
  }

  get vector(): Float32Array {
    return this._vector;
  }

  get position(): number {
    return this._position;
  }

  get startIndex(): number {
    return this._position * 2;
  }

  get frameCount(): number {
    return this._frameCount;
  }

  get endIndex(): number {
    return (this._position + this._frameCount) * 2;
  }

  clear(): void {
    this._vector.fill(0);
    this._position = 0;
    this._frameCount = 0;
  }

  put(numFrames: number): void {
    this._frameCount += numFrames;
  }

  putSamples(samples: Float32Array, position?: number, numFrames: number = 0): void {
    position = position || 0;
    const sourceOffset = position * 2;
    if (!(numFrames >= 0)) {
      numFrames = (samples.length - sourceOffset) / 2;
    }
    const numSamples = numFrames * 2;
    this.ensureCapacity(numFrames + this._frameCount);
    const destOffset = this.endIndex;
    this.vector.set(samples.subarray(sourceOffset, sourceOffset + numSamples), destOffset);
    this._frameCount += numFrames;
  }

  putBuffer(buffer: FifoSampleBuffer, position?: number, numFrames: number = 0): void {
    position = position || 0;
    if (!(numFrames >= 0)) {
      numFrames = buffer.frameCount - position;
    }
    this.putSamples(buffer.vector, buffer.position + position, numFrames);
  }

  receive(numFrames?: number): void {
    if (!(numFrames && numFrames >= 0) || numFrames! > this._frameCount) {
      numFrames = this.frameCount;
    }
    this._frameCount -= numFrames;
    this._position += numFrames;
  }

  receiveSamples(output: Float32Array, numFrames: number = 0): void {
    const numSamples = numFrames * 2;
    const sourceOffset = this.startIndex;
    output.set(this._vector.subarray(sourceOffset, sourceOffset + numSamples));
    this.receive(numFrames);
  }

  extract(output: Float32Array, position: number = 0, numFrames: number = 0): void {
    const sourceOffset = this.startIndex + position * 2;
    const numSamples = numFrames * 2;
    output.set(this._vector.subarray(sourceOffset, sourceOffset + numSamples));
  }

  ensureCapacity(numFrames: number = 0): void {
    const minLength = parseInt(String(numFrames * 2));
    if (this._vector.length < minLength) {
      const newVector = new Float32Array(minLength);
      newVector.set(this._vector.subarray(this.startIndex, this.endIndex));
      this._vector = newVector;
      this._position = 0;
    } else {
      this.rewind();
    }
  }

  ensureAdditionalCapacity(numFrames: number = 0): void {
    this.ensureCapacity(this._frameCount + numFrames);
  }

  rewind(): void {
    if (this._position > 0) {
      this._vector.set(this._vector.subarray(this.startIndex, this.endIndex));
      this._position = 0;
    }
  }
}

interface IPipe {
  inputBuffer: FifoSampleBuffer | null;
  outputBuffer: FifoSampleBuffer | null;
  clear(): void;
  process?(): void;
}

class AbstractFifoSamplePipe implements IPipe {
  protected _inputBuffer: FifoSampleBuffer | null;
  protected _outputBuffer: FifoSampleBuffer | null;

  constructor(createBuffers: boolean) {
    if (createBuffers) {
      this._inputBuffer = new FifoSampleBuffer();
      this._outputBuffer = new FifoSampleBuffer();
    } else {
      this._inputBuffer = this._outputBuffer = null;
    }
  }

  get inputBuffer(): FifoSampleBuffer | null {
    return this._inputBuffer;
  }

  set inputBuffer(inputBuffer: FifoSampleBuffer | null) {
    this._inputBuffer = inputBuffer;
  }

  get outputBuffer(): FifoSampleBuffer | null {
    return this._outputBuffer;
  }

  set outputBuffer(outputBuffer: FifoSampleBuffer | null) {
    this._outputBuffer = outputBuffer;
  }

  clear(): void {
    this._inputBuffer!.clear();
    this._outputBuffer!.clear();
  }
}

class RateTransposer extends AbstractFifoSamplePipe {
  private _rate: number;
  private slopeCount: number = 0;
  private prevSampleL: number = 0;
  private prevSampleR: number = 0;

  constructor(createBuffers: boolean) {
    super(createBuffers);
    this.reset();
    this._rate = 1;
  }

  set rate(rate: number) {
    this._rate = rate;
  }

  reset(): void {
    this.slopeCount = 0;
    this.prevSampleL = 0;
    this.prevSampleR = 0;
  }

  clear(): void {
    super.clear();
    this.reset();
  }

  clone(): RateTransposer {
    const result = new RateTransposer(true);
    result.rate = this._rate;
    return result;
  }

  process(): void {
    const numFrames = this._inputBuffer!.frameCount;
    this._outputBuffer!.ensureAdditionalCapacity(numFrames / this._rate + 1);
    const numFramesOutput = this.transpose(numFrames);
    this._inputBuffer!.receive();
    this._outputBuffer!.put(numFramesOutput);
  }

  transpose(numFrames: number = 0): number {
    if (numFrames === 0) {
      return 0;
    }
    const src = this._inputBuffer!.vector;
    const srcOffset = this._inputBuffer!.startIndex;
    const dest = this._outputBuffer!.vector;
    const destOffset = this._outputBuffer!.endIndex;
    let used = 0;
    let i = 0;
    while (this.slopeCount < 1.0) {
      dest[destOffset + 2 * i] = (1.0 - this.slopeCount) * this.prevSampleL + this.slopeCount * src[srcOffset];
      dest[destOffset + 2 * i + 1] = (1.0 - this.slopeCount) * this.prevSampleR + this.slopeCount * src[srcOffset + 1];
      i = i + 1;
      this.slopeCount += this._rate;
    }
    this.slopeCount -= 1.0;
    if (numFrames !== 1) {
      out: while (true) {
        while (this.slopeCount > 1.0) {
          this.slopeCount -= 1.0;
          used = used + 1;
          if (used >= numFrames - 1) {
            break out;
          }
        }
        const srcIndex = srcOffset + 2 * used;
        dest[destOffset + 2 * i] = (1.0 - this.slopeCount) * src[srcIndex] + this.slopeCount * src[srcIndex + 2];
        dest[destOffset + 2 * i + 1] = (1.0 - this.slopeCount) * src[srcIndex + 1] + this.slopeCount * src[srcIndex + 3];
        i = i + 1;
        this.slopeCount += this._rate;
      }
    }
    this.prevSampleL = src[srcOffset + 2 * numFrames - 2];
    this.prevSampleR = src[srcOffset + 2 * numFrames - 1];
    return i;
  }
}

class FilterSupport {
  protected _pipe: IPipe;

  constructor(pipe: IPipe) {
    this._pipe = pipe;
  }

  get pipe(): IPipe {
    return this._pipe;
  }

  get inputBuffer(): FifoSampleBuffer | null {
    return this._pipe.inputBuffer;
  }

  get outputBuffer(): FifoSampleBuffer | null {
    return this._pipe.outputBuffer;
  }

  fillInputBuffer(_numFrames?: number): void {
    throw new Error('fillInputBuffer() not overridden');
  }

  fillOutputBuffer(numFrames: number = 0): void {
    while (this.outputBuffer!.frameCount < numFrames) {
      const numInputFrames = 8192 * 2 - this.inputBuffer!.frameCount;
      this.fillInputBuffer(numInputFrames);
      if (this.inputBuffer!.frameCount < 8192 * 2) {
        break;
      }
      this._pipe.process!();
    }
  }

  clear(): void {
    this._pipe.clear();
  }
}

const noop = function (): void {
  return;
};

interface AudioSource {
  extract(target: Float32Array, numFrames: number, position: number): number;
}

class SimpleFilter extends FilterSupport {
  private callback: () => void;
  private sourceSound: AudioSource;
  private historyBufferSize: number;
  private _sourcePosition: number;
  private outputBufferPosition: number;
  private _position: number;

  constructor(sourceSound: AudioSource, pipe: IPipe, callback: () => void = noop) {
    super(pipe);
    this.callback = callback;
    this.sourceSound = sourceSound;
    this.historyBufferSize = 22050;
    this._sourcePosition = 0;
    this.outputBufferPosition = 0;
    this._position = 0;
  }

  get position(): number {
    return this._position;
  }

  set position(position: number) {
    if (position > this._position) {
      throw new RangeError('New position may not be greater than current position');
    }
    const newOutputBufferPosition = this.outputBufferPosition - (this._position - position);
    if (newOutputBufferPosition < 0) {
      throw new RangeError('New position falls outside of history buffer');
    }
    this.outputBufferPosition = newOutputBufferPosition;
    this._position = position;
  }

  get sourcePosition(): number {
    return this._sourcePosition;
  }

  set sourcePosition(sourcePosition: number) {
    this.clear();
    this._sourcePosition = sourcePosition;
  }

  onEnd(): void {
    this.callback();
  }

  fillInputBuffer(numFrames: number = 0): void {
    const samples = new Float32Array(numFrames * 2);
    const numFramesExtracted = this.sourceSound.extract(samples, numFrames, this._sourcePosition);
    this._sourcePosition += numFramesExtracted;
    this.inputBuffer!.putSamples(samples, 0, numFramesExtracted);
  }

  extract(target: Float32Array, numFrames: number = 0): number {
    this.fillOutputBuffer(this.outputBufferPosition + numFrames);
    const numFramesExtracted = Math.min(numFrames, this.outputBuffer!.frameCount - this.outputBufferPosition);
    this.outputBuffer!.extract(target, this.outputBufferPosition, numFramesExtracted);
    const currentFrames = this.outputBufferPosition + numFramesExtracted;
    this.outputBufferPosition = Math.min(this.historyBufferSize, currentFrames);
    this.outputBuffer!.receive(Math.max(currentFrames - this.historyBufferSize, 0));
    this._position += numFramesExtracted;
    return numFramesExtracted;
  }

  handleSampleData(event: { data: Float32Array }): void {
    this.extract(event.data, 4096);
  }

  clear(): void {
    super.clear();
    this.outputBufferPosition = 0;
  }
}

const USE_AUTO_SEQUENCE_LEN = 0;
const DEFAULT_SEQUENCE_MS = USE_AUTO_SEQUENCE_LEN;
const USE_AUTO_SEEKWINDOW_LEN = 0;
const DEFAULT_SEEKWINDOW_MS = USE_AUTO_SEEKWINDOW_LEN;
const DEFAULT_OVERLAP_MS = 8;
const _SCAN_OFFSETS: number[][] = [[124, 186, 248, 310, 372, 434, 496, 558, 620, 682, 744, 806, 868, 930, 992, 1054, 1116, 1178, 1240, 1302, 1364, 1426, 1488, 0], [-100, -75, -50, -25, 25, 50, 75, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [-20, -15, -10, -5, 5, 10, 15, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [-4, -3, -2, -1, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]];
const AUTOSEQ_TEMPO_LOW = 0.25;
const AUTOSEQ_TEMPO_TOP = 4.0;
const AUTOSEQ_AT_MIN = 125.0;
const AUTOSEQ_AT_MAX = 50.0;
const AUTOSEQ_K = (AUTOSEQ_AT_MAX - AUTOSEQ_AT_MIN) / (AUTOSEQ_TEMPO_TOP - AUTOSEQ_TEMPO_LOW);
const AUTOSEQ_C = AUTOSEQ_AT_MIN - AUTOSEQ_K * AUTOSEQ_TEMPO_LOW;
const AUTOSEEK_AT_MIN = 25.0;
const AUTOSEEK_AT_MAX = 15.0;
const AUTOSEEK_K = (AUTOSEEK_AT_MAX - AUTOSEEK_AT_MIN) / (AUTOSEQ_TEMPO_TOP - AUTOSEQ_TEMPO_LOW);
const AUTOSEEK_C = AUTOSEEK_AT_MIN - AUTOSEEK_K * AUTOSEQ_TEMPO_LOW;

class Stretch extends AbstractFifoSamplePipe {
  private _quickSeek: boolean;
  private midBuffer: Float32Array | null;
  private overlapLength: number;
  private autoSeqSetting: boolean;
  private autoSeekSetting: boolean;
  private _tempo: number;
  private sampleRate!: number;
  private overlapMs!: number;
  private sequenceMs!: number;
  private seekWindowMs!: number;
  private seekWindowLength!: number;
  private seekLength!: number;
  private nominalSkip!: number;
  private skipFract!: number;
  private sampleReq!: number;
  private refMidBuffer!: Float32Array;

  constructor(createBuffers: boolean) {
    super(createBuffers);
    this._quickSeek = true;
    this.midBuffer = null;
    this.overlapLength = 0;
    this.autoSeqSetting = true;
    this.autoSeekSetting = true;
    this._tempo = 1;
    this.setParameters(44100, DEFAULT_SEQUENCE_MS, DEFAULT_SEEKWINDOW_MS, DEFAULT_OVERLAP_MS);
  }

  clear(): void {
    super.clear();
    this.clearMidBuffer();
  }

  clearMidBuffer(): void {
    this.midBuffer = null;
    if (this.refMidBuffer) {
      this.refMidBuffer.fill(0);
    }
    this.skipFract = 0;
  }

  setParameters(sampleRate: number, sequenceMs: number, seekWindowMs: number, overlapMs: number): void {
    if (sampleRate > 0) {
      this.sampleRate = sampleRate;
    }
    if (overlapMs > 0) {
      this.overlapMs = overlapMs;
    }
    if (sequenceMs > 0) {
      this.sequenceMs = sequenceMs;
      this.autoSeqSetting = false;
    } else {
      this.autoSeqSetting = true;
    }
    if (seekWindowMs > 0) {
      this.seekWindowMs = seekWindowMs;
      this.autoSeekSetting = false;
    } else {
      this.autoSeekSetting = true;
    }
    this.calculateSequenceParameters();
    this.calculateOverlapLength(this.overlapMs);
    this.tempo = this._tempo;
  }

  set tempo(newTempo: number) {
    let intskip: number;
    this._tempo = newTempo;
    this.calculateSequenceParameters();
    this.nominalSkip = this._tempo * (this.seekWindowLength - this.overlapLength);
    this.skipFract = 0;
    intskip = Math.floor(this.nominalSkip + 0.5);
    this.sampleReq = Math.max(intskip + this.overlapLength, this.seekWindowLength) + this.seekLength;
  }

  get tempo(): number {
    return this._tempo;
  }

  get inputChunkSize(): number {
    return this.sampleReq;
  }

  get outputChunkSize(): number {
    return this.overlapLength + Math.max(0, this.seekWindowLength - 2 * this.overlapLength);
  }

  calculateOverlapLength(overlapInMsec: number = 0): void {
    let newOvl: number;
    newOvl = this.sampleRate * overlapInMsec / 1000;
    newOvl = newOvl < 16 ? 16 : newOvl;
    newOvl -= newOvl % 8;
    this.overlapLength = newOvl;
    this.refMidBuffer = new Float32Array(this.overlapLength * 2);
    this.midBuffer = new Float32Array(this.overlapLength * 2);
  }

  checkLimits(x: number, mi: number, ma: number): number {
    return x < mi ? mi : x > ma ? ma : x;
  }

  calculateSequenceParameters(): void {
    let seq: number;
    let seek: number;
    if (this.autoSeqSetting) {
      seq = AUTOSEQ_C + AUTOSEQ_K * this._tempo;
      seq = this.checkLimits(seq, AUTOSEQ_AT_MAX, AUTOSEQ_AT_MIN);
      this.sequenceMs = Math.floor(seq + 0.5);
    }
    if (this.autoSeekSetting) {
      seek = AUTOSEEK_C + AUTOSEEK_K * this._tempo;
      seek = this.checkLimits(seek, AUTOSEEK_AT_MAX, AUTOSEEK_AT_MIN);
      this.seekWindowMs = Math.floor(seek + 0.5);
    }
    this.seekWindowLength = Math.floor(this.sampleRate * this.sequenceMs / 1000);
    this.seekLength = Math.floor(this.sampleRate * this.seekWindowMs / 1000);
  }

  set quickSeek(enable: boolean) {
    this._quickSeek = enable;
  }

  clone(): Stretch {
    const result = new Stretch(true);
    result.tempo = this._tempo;
    result.setParameters(this.sampleRate, this.sequenceMs, this.seekWindowMs, this.overlapMs);
    return result;
  }

  seekBestOverlapPosition(): number {
    return this._quickSeek ? this.seekBestOverlapPositionStereoQuick() : this.seekBestOverlapPositionStereo();
  }

  seekBestOverlapPositionStereo(): number {
    let bestOffset: number;
    let bestCorrelation: number;
    let correlation: number;
    let i = 0;
    this.preCalculateCorrelationReferenceStereo();
    bestOffset = 0;
    bestCorrelation = Number.MIN_VALUE;
    for (; i < this.seekLength; i = i + 1) {
      correlation = this.calculateCrossCorrelationStereo(2 * i, this.refMidBuffer);
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestOffset = i;
      }
    }
    return bestOffset;
  }

  seekBestOverlapPositionStereoQuick(): number {
    let bestOffset: number;
    let bestCorrelation: number;
    let correlation: number;
    let scanCount = 0;
    let correlationOffset: number;
    let tempOffset: number;
    this.preCalculateCorrelationReferenceStereo();
    bestCorrelation = Number.MIN_VALUE;
    bestOffset = 0;
    correlationOffset = 0;
    tempOffset = 0;
    for (; scanCount < 4; scanCount = scanCount + 1) {
      let j = 0;
      while (_SCAN_OFFSETS[scanCount][j]) {
        tempOffset = correlationOffset + _SCAN_OFFSETS[scanCount][j];
        if (tempOffset >= this.seekLength) {
          break;
        }
        correlation = this.calculateCrossCorrelationStereo(2 * tempOffset, this.refMidBuffer);
        if (correlation > bestCorrelation) {
          bestCorrelation = correlation;
          bestOffset = tempOffset;
        }
        j = j + 1;
      }
      correlationOffset = bestOffset;
    }
    return bestOffset;
  }

  preCalculateCorrelationReferenceStereo(): void {
    let i = 0;
    let context: number;
    let temp: number;
    for (; i < this.overlapLength; i = i + 1) {
      temp = i * (this.overlapLength - i);
      context = i * 2;
      this.refMidBuffer[context] = this.midBuffer![context] * temp;
      this.refMidBuffer[context + 1] = this.midBuffer![context + 1] * temp;
    }
  }

  calculateCrossCorrelationStereo(mixingPosition: number, compare: Float32Array): number {
    const mixing = this._inputBuffer!.vector;
    mixingPosition += this._inputBuffer!.startIndex;
    let correlation = 0;
    let i = 2;
    const calcLength = 2 * this.overlapLength;
    let mixingOffset: number;
    for (; i < calcLength; i = i + 2) {
      mixingOffset = i + mixingPosition;
      correlation += mixing[mixingOffset] * compare[i] + mixing[mixingOffset + 1] * compare[i + 1];
    }
    return correlation;
  }

  overlap(overlapPosition: number): void {
    this.overlapStereo(2 * overlapPosition);
  }

  overlapStereo(inputPosition: number): void {
    const input = this._inputBuffer!.vector;
    inputPosition += this._inputBuffer!.startIndex;
    const output = this._outputBuffer!.vector;
    const outputPosition = this._outputBuffer!.endIndex;
    let i = 0;
    let context: number;
    let tempFrame: number;
    const frameScale = 1 / this.overlapLength;
    let fi: number;
    let inputOffset: number;
    let outputOffset: number;
    for (; i < this.overlapLength; i = i + 1) {
      tempFrame = (this.overlapLength - i) * frameScale;
      fi = i * frameScale;
      context = 2 * i;
      inputOffset = context + inputPosition;
      outputOffset = context + outputPosition;
      output[outputOffset + 0] = input[inputOffset + 0] * fi + this.midBuffer![context + 0] * tempFrame;
      output[outputOffset + 1] = input[inputOffset + 1] * fi + this.midBuffer![context + 1] * tempFrame;
    }
  }

  process(): void {
    let offset: number;
    let temp: number;
    let overlapSkip: number;
    if (this.midBuffer === null) {
      if (this._inputBuffer!.frameCount < this.overlapLength) {
        return;
      }
      this.midBuffer = new Float32Array(this.overlapLength * 2);
      this._inputBuffer!.receiveSamples(this.midBuffer, this.overlapLength);
    }
    while (this._inputBuffer!.frameCount >= this.sampleReq) {
      offset = this.seekBestOverlapPosition();
      this._outputBuffer!.ensureAdditionalCapacity(this.overlapLength);
      this.overlap(Math.floor(offset));
      this._outputBuffer!.put(this.overlapLength);
      temp = this.seekWindowLength - 2 * this.overlapLength;
      if (temp > 0) {
        this._outputBuffer!.putBuffer(this._inputBuffer!, offset + this.overlapLength, temp);
      }
      const start = this._inputBuffer!.startIndex + 2 * (offset + this.seekWindowLength - this.overlapLength);
      this.midBuffer.set(this._inputBuffer!.vector.subarray(start, start + 2 * this.overlapLength));
      this.skipFract += this.nominalSkip;
      overlapSkip = Math.floor(this.skipFract);
      this.skipFract -= overlapSkip;
      this._inputBuffer!.receive(overlapSkip);
    }
  }
}

const testFloatEqual = function (a: number, b: number): boolean {
  return (a > b ? a - b : b - a) > 1e-10;
};

class SoundTouch implements IPipe {
  private transposer: RateTransposer;
  private stretch: Stretch;
  private _inputBuffer: FifoSampleBuffer;
  private _intermediateBuffer: FifoSampleBuffer;
  private _outputBuffer: FifoSampleBuffer;
  private _rate: number;
  private _tempo: number;
  private virtualPitch: number;
  private virtualRate: number;
  private virtualTempo: number;

  constructor() {
    this.transposer = new RateTransposer(false);
    this.stretch = new Stretch(false);
    this._inputBuffer = new FifoSampleBuffer();
    this._intermediateBuffer = new FifoSampleBuffer();
    this._outputBuffer = new FifoSampleBuffer();
    this._rate = 0;
    this._tempo = 0;
    this.virtualPitch = 1.0;
    this.virtualRate = 1.0;
    this.virtualTempo = 1.0;
    this.calculateEffectiveRateAndTempo();
  }

  clear(): void {
    this.transposer.clear();
    this.stretch.clear();
  }

  clone(): SoundTouch {
    const result = new SoundTouch();
    result.rate = this.rate;
    result.tempo = this.tempo;
    return result;
  }

  get rate(): number {
    return this._rate;
  }

  set rate(rate: number) {
    this.virtualRate = rate;
    this.calculateEffectiveRateAndTempo();
  }

  set rateChange(rateChange: number) {
    this._rate = 1.0 + 0.01 * rateChange;
  }

  get tempo(): number {
    return this._tempo;
  }

  set tempo(tempo: number) {
    this.virtualTempo = tempo;
    this.calculateEffectiveRateAndTempo();
  }

  set tempoChange(tempoChange: number) {
    this.tempo = 1.0 + 0.01 * tempoChange;
  }

  set pitch(pitch: number) {
    this.virtualPitch = pitch;
    this.calculateEffectiveRateAndTempo();
  }

  set pitchOctaves(pitchOctaves: number) {
    this.pitch = Math.exp(0.69314718056 * pitchOctaves);
    this.calculateEffectiveRateAndTempo();
  }

  set pitchSemitones(pitchSemitones: number) {
    this.pitchOctaves = pitchSemitones / 12.0;
  }

  get inputBuffer(): FifoSampleBuffer {
    return this._inputBuffer;
  }

  get outputBuffer(): FifoSampleBuffer {
    return this._outputBuffer;
  }

  calculateEffectiveRateAndTempo(): void {
    const previousTempo = this._tempo;
    const previousRate = this._rate;
    this._tempo = this.virtualTempo / this.virtualPitch;
    this._rate = this.virtualRate * this.virtualPitch;
    if (testFloatEqual(this._tempo, previousTempo)) {
      this.stretch.tempo = this._tempo;
    }
    if (testFloatEqual(this._rate, previousRate)) {
      this.transposer.rate = this._rate;
    }
    if (this._rate > 1.0) {
      if (this._outputBuffer != this.transposer.outputBuffer) {
        this.stretch.inputBuffer = this._inputBuffer;
        this.stretch.outputBuffer = this._intermediateBuffer;
        this.transposer.inputBuffer = this._intermediateBuffer;
        this.transposer.outputBuffer = this._outputBuffer;
      }
    } else {
      if (this._outputBuffer != this.stretch.outputBuffer) {
        this.transposer.inputBuffer = this._inputBuffer;
        this.transposer.outputBuffer = this._intermediateBuffer;
        this.stretch.inputBuffer = this._intermediateBuffer;
        this.stretch.outputBuffer = this._outputBuffer;
      }
    }
  }

  process(): void {
    if (this._rate > 1.0) {
      this.stretch.process();
      this.transposer.process();
    } else {
      this.transposer.process();
      this.stretch.process();
    }
  }
}

class WebAudioBufferSource implements AudioSource {
  private buffer: AudioBuffer;
  private _position: number;

  constructor(buffer: AudioBuffer) {
    this.buffer = buffer;
    this._position = 0;
  }

  get dualChannel(): boolean {
    return this.buffer.numberOfChannels > 1;
  }

  get position(): number {
    return this._position;
  }

  set position(value: number) {
    this._position = value;
  }

  extract(target: Float32Array, numFrames: number = 0, position: number = 0): number {
    this.position = position;
    let left = this.buffer.getChannelData(0);
    let right = this.dualChannel ? this.buffer.getChannelData(1) : this.buffer.getChannelData(0);
    let i = 0;
    for (; i < numFrames; i++) {
      target[i * 2] = left[i + position];
      target[i * 2 + 1] = right[i + position];
    }
    return Math.min(numFrames, left.length - position);
  }
}

const getWebAudioNode = function (
  context: AudioContext,
  filter: SimpleFilter,
  sourcePositionCallback: (position: number) => void = noop as any,
  bufferSize: number = 4096
): ScriptProcessorNode {
  const node = context.createScriptProcessor(bufferSize, 2, 2);
  const samples = new Float32Array(bufferSize * 2);
  node.onaudioprocess = (event: AudioProcessingEvent) => {
    let left = event.outputBuffer.getChannelData(0);
    let right = event.outputBuffer.getChannelData(1);
    let framesExtracted = filter.extract(samples, bufferSize);
    sourcePositionCallback(filter.sourcePosition);
    if (framesExtracted === 0) {
      filter.onEnd();
    }
    let i = 0;
    for (; i < framesExtracted; i++) {
      left[i] = samples[i * 2];
      right[i] = samples[i * 2 + 1];
    }
  };
  return node;
};

const pad = function (n: number | string, width: number, z?: string): string {
  z = z || '0';
  n = n + '';
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
};

const minsSecs = function (secs: number): string {
  const mins = Math.floor(secs / 60);
  const seconds = secs - mins * 60;
  return `${mins}:${pad(parseInt(String(seconds)), 2)}`;
};

interface PlayEventDetail {
  timePlayed: number;
  formattedTimePlayed: string;
  percentagePlayed: number;
}

const onUpdate = function (this: PitchShifter, sourcePosition: number): void {
  const currentTimePlayed = this.timePlayed;
  const sampleRate = this.sampleRate;
  this.sourcePosition = sourcePosition;
  this.timePlayed = sourcePosition / sampleRate;
  if (currentTimePlayed !== this.timePlayed) {
    const timePlayed = new CustomEvent<PlayEventDetail>('play', {
      detail: {
        timePlayed: this.timePlayed,
        formattedTimePlayed: this.formattedTimePlayed,
        percentagePlayed: this.percentagePlayed
      }
    });
    this._node.dispatchEvent(timePlayed);
  }
};

interface EventListener {
  name: string;
  cb: (detail: PlayEventDetail) => void;
}

class PitchShifter {
  private _soundtouch: SoundTouch;
  private _filter: SimpleFilter;
  public _node: ScriptProcessorNode;
  public timePlayed: number;
  public sourcePosition: number;
  public tempo: number;
  public rate: number;
  public duration: number;
  public sampleRate: number;
  private listeners: EventListener[];

  constructor(context: AudioContext, buffer: AudioBuffer, bufferSize: number, onEnd: () => void = noop) {
    this._soundtouch = new SoundTouch();
    const source = new WebAudioBufferSource(buffer);
    this.timePlayed = 0;
    this.sourcePosition = 0;
    this._filter = new SimpleFilter(source, this._soundtouch, onEnd);
    this._node = getWebAudioNode(context, this._filter, (sourcePosition: number) => onUpdate.call(this, sourcePosition), bufferSize);
    this.tempo = 1;
    this.rate = 1;
    this.duration = buffer.duration;
    this.sampleRate = context.sampleRate;
    this.listeners = [];
  }

  get formattedDuration(): string {
    return minsSecs(this.duration);
  }

  get formattedTimePlayed(): string {
    return minsSecs(this.timePlayed);
  }

  get percentagePlayed(): number {
    return 100 * this._filter.sourcePosition / (this.duration * this.sampleRate);
  }

  set percentagePlayed(perc: number) {
    this._filter.sourcePosition = parseInt(String(perc * this.duration * this.sampleRate));
    this.sourcePosition = this._filter.sourcePosition;
    this.timePlayed = this.sourcePosition / this.sampleRate;
  }

  get node(): ScriptProcessorNode {
    return this._node;
  }

  set pitch(pitch: number) {
    this._soundtouch.pitch = pitch;
  }

  set pitchSemitones(semitone: number) {
    this._soundtouch.pitchSemitones = semitone;
  }

  connect(toNode: AudioNode): void {
    this._node.connect(toNode);
  }

  disconnect(): void {
    this._node.disconnect();
  }

  on(eventName: string, cb: (detail: PlayEventDetail) => void): void {
    this.listeners.push({
      name: eventName,
      cb: cb
    });
    this._node.addEventListener(eventName, (event: Event) => cb((event as CustomEvent<PlayEventDetail>).detail));
  }

  off(eventName: string | null = null): void {
    let listeners = this.listeners;
    if (eventName) {
      listeners = listeners.filter(e => e.name === eventName);
    }
    listeners.forEach(e => {
      this._node.removeEventListener(e.name, (event: Event) => e.cb((event as CustomEvent<PlayEventDetail>).detail));
    });
  }
}

export { AbstractFifoSamplePipe, PitchShifter, RateTransposer, SimpleFilter, SoundTouch, Stretch, WebAudioBufferSource, getWebAudioNode };
