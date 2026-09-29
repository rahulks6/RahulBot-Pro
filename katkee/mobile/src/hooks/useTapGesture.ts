import { useCallback, useRef } from "react";

const DOUBLE_TAP_WINDOW_MS = 250;

/**
 * Distinguishes a single tap from a double tap without a gesture library —
 * a single tap only fires after DOUBLE_TAP_WINDOW_MS has passed with no
 * second tap, so it never fires before a double tap has had the chance to
 * be recognized (spec section 4: "do not execute single-tap navigation
 * before determining whether the gesture is a double tap" — the same rule
 * applies here for the camera preview's double-tap-to-flip).
 */
export function useTapGesture(onSingleTap: (x: number, y: number) => void, onDoubleTap: () => void) {
  const lastTapRef = useRef<number>(0);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (x: number, y: number) => {
      const now = Date.now();
      const sinceLastTap = now - lastTapRef.current;
      lastTapRef.current = now;

      if (sinceLastTap < DOUBLE_TAP_WINDOW_MS) {
        if (pendingTimer.current) {
          clearTimeout(pendingTimer.current);
          pendingTimer.current = null;
        }
        onDoubleTap();
        return;
      }

      pendingTimer.current = setTimeout(() => {
        pendingTimer.current = null;
        onSingleTap(x, y);
      }, DOUBLE_TAP_WINDOW_MS);
    },
    [onSingleTap, onDoubleTap],
  );
}
