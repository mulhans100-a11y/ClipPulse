export interface VirtualWindow { start: number; end: number; topPadding: number; bottomPadding: number; }

export function mediaVirtualWindow(itemCount: number, scrollTop: number, viewportHeight: number, itemHeight = 64, overscan = 5): VirtualWindow {
  if (itemCount <= 0 || itemHeight <= 0) return { start: 0, end: 0, topPadding: 0, bottomPadding: 0 };
  const height = Math.max(0, viewportHeight);
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, itemCount * itemHeight - height));
  const start = Math.max(0, Math.floor(top / itemHeight) - overscan);
  const end = Math.min(itemCount, Math.ceil((top + height) / itemHeight) + overscan);
  return { start, end, topPadding: start * itemHeight, bottomPadding: (itemCount - end) * itemHeight };
}
