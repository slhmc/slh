/** The displayed scale is relative to SLH's compact 90% baseline. */
export function interfaceZoom(percent: number): number {
  return percent * 0.9 / 100;
}
