/**
 * Human-readable number formatting for console and cost display.
 *
 * Both functions are pure: no I/O, no randomness, no locale dependency.
 * Same input always produces byte-identical output.
 */

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/**
 * Format a finite number as a USD currency string.
 *
 * Produces `$`-prefixed strings with exactly two decimal places and
 * thousands separators (e.g. `$1,234.50`). Zero yields `$0.00`; negative
 * values place the minus sign before the `$` (e.g. `-$1,234.50`).
 *
 * Throws TypeError for NaN, Infinity, -Infinity, or non-number inputs.
 */
export function formatUsd(amount: number): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new TypeError(
      `formatUsd expects a finite number, got ${String(amount)}`,
    );
  }
  return usdFormatter.format(amount);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;
const BYTE_THRESHOLD = 1024;

/**
 * Format a non-negative finite number of bytes with an adaptive unit.
 *
 * Selects B/KB/MB/GB based on 1024-step thresholds. B values are integers;
 * KB and above use two decimal places. Values beyond the GB range remain
 * expressed in GB (e.g. 2 TiB -> `2048.00 GB`).
 *
 * Throws RangeError for negative numbers.
 * Throws TypeError for NaN, Infinity, -Infinity, or non-number inputs.
 */
export function formatBytes(bytes: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
    throw new TypeError(
      `formatBytes expects a finite number, got ${String(bytes)}`,
    );
  }
  if (bytes < 0) {
    throw new RangeError(
      `formatBytes expects a non-negative number, got ${bytes}`,
    );
  }

  const lastIndex = BYTE_UNITS.length - 1;
  let value = bytes;
  let unitIndex = 0;

  while (value >= BYTE_THRESHOLD && unitIndex < lastIndex) {
    value /= BYTE_THRESHOLD;
    unitIndex++;
  }

  const unit = BYTE_UNITS[unitIndex];
  if (unitIndex === 0) {
    return `${Math.round(value)} ${unit}`;
  }
  return `${value.toFixed(2)} ${unit}`;
}
