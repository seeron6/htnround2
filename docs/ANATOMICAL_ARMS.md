# Anatomical first-person arms

Open `/arm-review.html` to inspect the same `PresetArm` used by the app and arm
personalization dialog. The review offers open/fist, reach, wrist rotation, an
orbit view, joint markers, skin/fabric colours, sleeves, watch, and ring. The
dialog also includes reach/grip controls and a full-arm view. These controls
only change the preview; **Use these arms** saves appearance as before.

`src/preset-arm.js` now exports the continuous anatomical arm in
`src/anatomical-arm.js`. The separate cylinder and WebXR-hand construction is
no longer used for personalized arms. `src/preset-hand.js` is retained for its
other consumers/tests.

Shoulder, elbow and wrist are the driving anchors. A two-link IK solve keeps
upper-arm/forearm lengths fixed, chooses a stable elbow bend plane, and limits
unreachable targets. Existing `ArmDynamics` supplies recoil and smoothing.
24 weighted bones deform the connected skin, including finger joints and
distributed forearm twist. Arm width changes girth without stretching bones.
The elbow is inferred from wrist motion and a bend-plane target; this is not
independently measured elbow tracking.

In **My 3D arms**, the camera's metric palm landmarks now drive wrist orientation
as well as reach. Both hands can roll, flex and tilt while the avatar keeps its
boxing fist. Quaternion smoothing reduces jitter and follows the short arc at
180 degrees; bend is limited relative to the inferred forearm while axial roll
remains free. If metric landmarks are unavailable, aspect-corrected image
landmarks provide the orientation. The preview roll slider remains independent.
`tests/wrist-tracking-browser.html` exercises the production tracking and preset
update path with synthetic camera frames and a disconnected-wrist comparison.

Materials retain a subtle bump detail map. Scanned skin uses the measured
color with neutral atlas variation; the template's skin hue is not retained.
Saved scan strips are applied to the visible forearm and upper-arm regions.
Unseen skin uses the measured color and template detail. Sleeves have their own
surface, cotton weave, asymmetric folds, and cuffs. Covered skin is masked
under garments to prevent it protruding at bends. These folds are a procedural
approximation, not a cloth simulation. The watch and ring follow their bones;
the ring fits outside the selected finger's cross-section. A scan can detect
asymmetric accessories and their colors from repeated visible evidence.

This is a generic anatomical template, not a reconstruction of the user's arms
or the linked Sketchfab asset. It improves anatomy and shading over the old
primitives but is not a claim of scan-level photorealism. Provenance and rebuild
commands are in `public/models/arms/SOURCE.md`.

Validation: `node --test tests/anatomical-arm.test.mjs tests/arm-personalization.test.mjs tests/arm-pose.test.mjs`,
production build, and browser inspection of open/fist, reach, wrist rotation,
bare/short/long/hoodie surfaces and synthetic scan preservation. Live webcam
retargeting needs a user's camera session to assess sensor accuracy.
