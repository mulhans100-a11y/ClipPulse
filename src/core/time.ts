import { AppError } from './errors';
import type { Rational } from './types';

export function rational(num: bigint | number | string, den: bigint | number | string = 1): Rational {
  let n = BigInt(num), d = BigInt(den);
  if (d === 0n) throw new AppError('INVALID_TIME', 'A rational time cannot have a zero denominator.');
  if (d < 0n) { n = -n; d = -d; }
  const gcd = (a: bigint, b: bigint): bigint => b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b);
  const g = gcd(n, d) || 1n;
  return { num: String(n / g), den: String(d / g) };
}

export function parseDecimal(value: string | number): Rational {
  const s = String(value).trim();
  if (/^-?\d+\/\d+$/.test(s)) {
    const [n, d] = s.split('/');
    return rational(n, d);
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new AppError('INVALID_TIME', `Invalid time value: ${s}`);
  const scale = 10n ** BigInt(m[3]?.length ?? 0);
  const whole = BigInt(m[2]) * scale + BigInt(m[3] || '0');
  return rational((m[1] ? -whole : whole), scale);
}

export function add(a: Rational, b: Rational): Rational {
  return rational(BigInt(a.num) * BigInt(b.den) + BigInt(b.num) * BigInt(a.den), BigInt(a.den) * BigInt(b.den));
}
export function sub(a: Rational, b: Rational): Rational {
  return rational(BigInt(a.num) * BigInt(b.den) - BigInt(b.num) * BigInt(a.den), BigInt(a.den) * BigInt(b.den));
}
export function compare(a: Rational, b: Rational): number {
  const delta = BigInt(a.num) * BigInt(b.den) - BigInt(b.num) * BigInt(a.den);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
export function seconds(value: Rational): number { return Number(value.num) / Number(value.den); }
export function decimal(value: Rational, places = 9): string {
  const scaled = (BigInt(value.num) * 10n ** BigInt(places)) / BigInt(value.den);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const scale = 10n ** BigInt(places);
  const whole = abs / scale;
  const fractional = String(abs % scale).padStart(places, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fractional ? `.${fractional}` : ''}`;
}
export function frameTime(frame: number, fps: Rational): Rational {
  if (!Number.isSafeInteger(frame)) throw new AppError('INVALID_FRAME', 'Frame number must be a safe integer.');
  return rational(BigInt(frame) * BigInt(fps.den), fps.num);
}
export function toFrame(time: Rational, fps: Rational): number {
  const n = BigInt(time.num) * BigInt(fps.num);
  const d = BigInt(time.den) * BigInt(fps.den);
  const rounded = (n * 2n + d) / (2n * d);
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new AppError('TIME_OVERFLOW', 'Time is too large to represent as timeline frames.');
  return result;
}
export function end(start: Rational, duration: Rational): Rational { return add(start, duration); }
export function clampNonNegative(time: Rational, field: string): void {
  if (BigInt(time.num) < 0n) throw new AppError('INVALID_TIME', `${field} cannot be negative.`);
}
