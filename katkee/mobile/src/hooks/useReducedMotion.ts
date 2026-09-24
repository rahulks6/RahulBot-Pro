import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Reads the OS-level "Reduce Motion" setting (spec: "reduced-motion
 * support where practical") via React Native's core `AccessibilityInfo` —
 * no new dependency needed, and it's kept live via the change event so a
 * setting flipped while the app is open takes effect without a restart.
 * Defaults to `false` (full motion) until the initial check resolves.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) setReduced(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => setReduced(enabled));
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return reduced;
}
