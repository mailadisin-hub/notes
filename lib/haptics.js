/**
 * Every tap in this app is a guess until the phone answers. Android WebView
 * gives no tap sound and no pressed state once a finger covers the row, so a
 * few milliseconds of vibration is the only confirmation a swipe or a checkbox
 * ever gets. Durations are deliberately tiny - anything past ~20ms reads as a
 * buzz rather than a click.
 */

const CAN_VIBRATE = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

let enabled = true;

export function setHapticsEnabled(on) {
  enabled = !!on;
}

export function haptic(kind = 'tap') {
  if (!enabled || !CAN_VIBRATE) return;
  const pattern = {
    tap: 8,
    select: 11,
    toggle: 13,
    commit: 18,
    warn: [14, 40, 14],
  }[kind] ?? 8;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* Some OEM builds throw when the user has system haptics off. */
  }
}
