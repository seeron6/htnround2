# Model upload and interaction checks — 2026-09-19

Tested the running app at `http://localhost:5173/` using its visible buttons,
the native macOS file picker, keyboard punches, and Reset head. Runtime geometry
diagnostics were read after the UI actions; they did not replace the actions.

## Fixes

- Automatic Vite reloads are now opt-in (`CONTACT_HMR=1`). Source saves had been
  resetting the page during video import. The supplied video finished importing
  while a watched source file was touched after the fix.
- Restarted the outdated development services. The old API returned Unknown
  endpoint for the Meshy controls served by the newer frontend. No reconstruction
  jobs were running when the old supervisor was stopped.
- Restored an accessible **Upload portrait photo** button. The React layout had
  hidden the capture guide containing the existing photo import control.
- Photo decoding failures now show a readable error and reset the file input.
  An invalid PNG was rejected without replacing the current model; a valid PNG
  then loaded through the same control.

## Verified flows

| Flow | Observed result |
| --- | --- |
| `IMG_7497.mov` → local reconstruction → interactive head | 44 saved views, 44 recovered cameras, Newton CPU physics with 4,518 tetrahedra. Held Q punch visibly deformed the face; Reset restored it. |
| Existing Meshy GLB → Upload GLB head → interaction | Textured mesh loaded; Q and E produced contacts and visible deformation; Reset restored zero displacement. |
| Fresh local model → Export GLB → Upload GLB head → interaction | Export saved successfully. Reimport retained the photographic texture; Space produced an uppercut; Reset restored it. Imported GLBs use preview physics. |
| Frontal PNG → Upload portrait photo → interaction | Photo preview loaded, Q deformed it, and Reset restored it. This existing feature estimates frontal depth; it does not reconstruct the back of the head. |
| Saved Meshy scan → Load Meshy head → refresh → interaction | The saved Meshy result loaded through the engine UI, survived a normal refresh, and accepted an E punch afterward. No new cloud task was submitted. |
| Frontal PNG → Import head photos | One tracked frontal view saved and the Meshy Create button became enabled. Cloud generation remains pending below. |

Geometry remained finite in the observed impact checks. Observed peak UI readings
were 35.2 mm for the new local model, 32.4/33.1 mm for imported Meshy hooks,
31.2 mm for the reimported local model's uppercut, and 54.1 mm for the portrait.
These measure the application's artistic deformation, not physical accuracy.

The first completed local run measured 28.584 seconds for extraction,
116.325 seconds for reconstruction, and 8.257 seconds to load the model and
physics: 153.166 seconds total processing time. User waiting between steps is
excluded. AI completion was unchecked for this local-only run.

## Remaining work — the full goal is not complete

Fresh Meshy generation from both the supplied video and a single photo still
needs end-to-end verification. Permission was requested to send the cropped
views to Meshy and use up to 60 credits for those two builds. These were not
submitted while that permission was pending. Existing-model loading is not
evidence that a new cloud build succeeds.

Prepared inputs:

- Video scan: `.local/face-captures/a0caa0c3c300423f86c624deaced6054/`
- Single-photo scan: `.local/face-captures/0efc9812b08c45f8af9e3efafb0f59a4/`
- Existing Meshy reference: `.local/face-captures/7a2bc070892642999d3357c2c5838390/meshy/model.glb`
- Exported local model: `.local/exports/punching-face.glb`
- Local evidence and logs: `.local/user-cycle/`

## Code checks

- `node --test tests/*.test.mjs`: 127 passed, 2 skipped, 0 failed.
- `npm run build -- --outDir .local/user-cycle/dist`: passed, including public
  assets. A dedicated output directory avoided concurrent writes to `dist`.
- Diff whitespace checks passed for the edited files.

These checks apply to the current shared worktree, which also contains ongoing
reconstruction work from other tasks. They do not certify unseen input files or
unexecuted cloud builds.
