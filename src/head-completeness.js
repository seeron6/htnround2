// Reject known partial reconstructions before replacing the current scene.
export function requireCompleteHead(stats = {}, appearance = {}) {
  if (
    stats.includesHairCapture === false ||
    stats.source === 'Single image landmark proxy' ||
    stats.appearance?.rearAppearance === 'Unobserved gray' ||
    stats.appearance?.fullHead === false ||
    appearance.rearAppearance === 'Unobserved gray' ||
    appearance.fullHead === false
  )
    throw new Error(
      'This older scan only captured the face. Record or import whole-head views including hair, ears, both sides and the back.',
    );
}
