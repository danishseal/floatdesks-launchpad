/** Simple Moving Average */
export function calculateSMA(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += closes[j];
    }
    result.push(sum / period);
  }
  return result;
}

/** Exponential Moving Average */
export function calculateEMA(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const k = 2 / (period + 1);

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += closes[j];
      result.push(sum / period);
    } else {
      const prev = result[result.length - 1]!;
      result.push(closes[i] * k + prev * (1 - k));
    }
  }
  return result;
}

/** Bollinger Bands (SMA ± stdDev * multiplier) */
export interface BollingerResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
}

export function calculateBollingerBands(
  closes: number[],
  period: number = 20,
  mult: number = 2,
): BollingerResult {
  const middle = calculateSMA(closes, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (middle[i] === null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSq += (closes[j] - middle[i]!) ** 2;
    }
    const sd = Math.sqrt(sumSq / period);
    upper.push(middle[i]! + mult * sd);
    lower.push(middle[i]! - mult * sd);
  }

  return { upper, middle, lower };
}

/** RSI (Wilder smoothing) */
export function calculateRSI(closes: number[], period: number = 14): (number | null)[] {
  if (closes.length < period + 1) return closes.map(() => null);

  const result: (number | null)[] = [null];
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i < period) {
        result.push(null);
        continue;
      }
      avgGain /= period;
      avgLoss /= period;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) {
      result.push(100);
    } else {
      result.push(100 - 100 / (1 + avgGain / avgLoss));
    }
  }

  return result;
}

/** MACD (fast EMA - slow EMA, signal EMA, histogram) */
export interface MACDResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

export function calculateMACD(
  closes: number[],
  fast: number = 12,
  slow: number = 26,
  signal: number = 9,
): MACDResult {
  const fastEma = calculateEMA(closes, fast);
  const slowEma = calculateEMA(closes, slow);

  const macdLine: (number | null)[] = [];
  const macdNonNull: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (fastEma[i] === null || slowEma[i] === null) {
      macdLine.push(null);
    } else {
      const v = fastEma[i]! - slowEma[i]!;
      macdLine.push(v);
      macdNonNull.push(v);
    }
  }

  const signalEma = calculateEMA(macdNonNull, signal);

  const signalLine: (number | null)[] = [];
  const histogram: (number | null)[] = [];
  let idx = 0;

  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] === null) {
      signalLine.push(null);
      histogram.push(null);
    } else {
      const sig = signalEma[idx] ?? null;
      signalLine.push(sig);
      histogram.push(sig !== null ? macdLine[i]! - sig : null);
      idx++;
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}
