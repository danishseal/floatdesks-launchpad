import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// XYZ has 6 decimals: 1 XYZ = 1,000,000 uxyz
const UXYZ_DECIMALS = 6;
const UXYZ_MULTIPLIER = 10 ** UXYZ_DECIMALS;

/**
 * Convert display XYZ amount to micro-unit uxyz string for contract calls.
 * Example: "1.5" -> "1500000"
 */
export function toUxyz(xyzAmount: string): string {
  const num = Number(xyzAmount);
  if (isNaN(num) || num <= 0) return "0";
  return Math.floor(num * UXYZ_MULTIPLIER).toString();
}

/**
 * Convert micro-unit uxyz string to display XYZ number.
 * Example: "1500000" -> 1.5
 */
export function fromUxyz(uxyzAmount: string): number {
  const num = Number(uxyzAmount);
  if (isNaN(num)) return 0;
  return num / UXYZ_MULTIPLIER;
}

/**
 * Format a uxyz amount as a human-readable XYZ string.
 * Example: "1500000" -> "1.50 DOT"
 */
export function formatXyzAmount(uxyzAmount: string): string {
  const num = fromUxyz(uxyzAmount);
  if (num === 0) return "0 DOT";
  if (num < 0.001) return `${num.toExponential(2)} DOT`;
  if (num < 1) return `${num.toFixed(6)} DOT`;
  if (num < 1000) return `${num.toFixed(2)} DOT`;
  if (num < 1_000_000) return `${(num / 1000).toFixed(1)}K DOT`;
  return `${(num / 1_000_000).toFixed(2)}M DOT`;
}

/**
 * Format a token amount (also 6 decimals for CW20 tokens) as human-readable string.
 * Example: "1500000" -> "1.50"
 */
export function formatTokenAmount(amount: string): string {
  const num = Number(amount) / UXYZ_MULTIPLIER;
  if (num === 0) return "0";
  if (num < 0.01) return num.toExponential(2);
  if (num < 1000) return num.toFixed(2);
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Format a number as a USD string.
 */
export function formatUsd(usdAmount: number): string {
  if (usdAmount === 0) return "$0.00";
  if (usdAmount < 0.0001) return `$${usdAmount.toExponential(2)}`;
  if (usdAmount < 0.01) return `$${usdAmount.toFixed(6)}`;
  if (usdAmount < 1) return `$${usdAmount.toFixed(4)}`;
  if (usdAmount < 1000) return `$${usdAmount.toFixed(2)}`;
  if (usdAmount < 1_000_000) return `$${(usdAmount / 1000).toFixed(1)}K`;
  if (usdAmount < 1_000_000_000) return `$${(usdAmount / 1_000_000).toFixed(2)}M`;
  return `$${(usdAmount / 1_000_000_000).toFixed(2)}B`;
}

/**
 * Format a uxyz amount as a USD string using oracle price.
 */
export function formatUxyzAsUsd(uxyzAmount: string, xyzPriceUsd: number): string {
  return formatUsd(fromUxyz(uxyzAmount) * xyzPriceUsd);
}

/**
 * Compute minimum output with slippage tolerance using BigInt for precision.
 * slippagePercent is in percentage (e.g., 1 = 1%, 0.5 = 0.5%).
 * Example: computeMinOutput("1000000", 1) -> "990000"
 */
export function computeMinOutput(
  simulatedOutput: string,
  slippagePercent: number
): string {
  const output = BigInt(simulatedOutput);
  // Convert slippage% to basis points: 1% = 100 bps
  // Multiply by 100 to support 0.1% precision
  const slippageBps = Math.round(slippagePercent * 100);
  const minOutput = (output * BigInt(10000 - slippageBps)) / BigInt(10000);
  return minOutput.toString();
}
