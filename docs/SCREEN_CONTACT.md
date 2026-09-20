# On-screen webcam contacts

Gameplay uses `src/screen-contact.js`, through `WebcamPunching.getView` in
`src/main.js`. Camera-depth punch extraction remains available for the start gesture
and the target-camera tools; it does not decide whether a gameplay hit lands.

- Live camera hands use the same cover crop and mirror transform as the arm overlay.
  A separate arm camera supplies its own landmarks with the displayed frame.
- Skeleton hands use their rendered knuckle coordinates. Preset hands account for
  the smoothed palm position. Forward motion of rendered hands supplies strike
  strength, while screen overlap determines contact.
- A moving knuckle circle is swept continuously against the projected triangles of
  the current mesh. Triangle interiors and edges count, including a crossing whose
  two tracked endpoints both miss. The contact is mapped back onto the actual
  triangle with perspective-correct interpolation.
- Each hand retains its own contact/retraction state. Holding or jittering does not
  repeat a hit. Following through beyond the far side keeps the strike latched, so
  bringing the fist back cannot punch the opposite cheek. Returning outside the
  entry side, or a pullback followed by a new extension, re-arms it.
- Tracking samples are drained in order, so an out-and-back movement between render
  frames survives. A short dropout can be bridged by observed endpoints; stale
  tracking, model/source/view changes, and paused gameplay reset the history.
- `ImpactPreparation` retains burst requests instead of rejecting the fifth pending
  punch. At most four unique jobs are posted at a time; identical jobs share a solve
  and deliver a separate reaction event for every contact.

`window.__punchingFace.punchCV.lastEvent` includes `source: 'screen'`, the CSS-pixel
contact, the mesh-local point, and whether the tissue rig accepted the impact.

Validation:

```sh
node --test tests/screen-contact.test.mjs tests/punch-mapping.test.mjs
node --test tests/impact-preparation.test.mjs
```

The browser replay through `feedPunchFrames` registered all six rapid contacts and
visibly deformed the reference head. This is synthetic tracking validation; camera
occlusion or motion blur that removes an entire strike still cannot be recovered
from coordinates the tracker never supplied.
