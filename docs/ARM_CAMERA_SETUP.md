# Real arms and a separate body camera

Open [the local app](http://localhost:5173/), reload it after an update, and choose **Advanced mode** if the welcome screen is open. In the **Camera** panel, open **How to set up a separate camera**. If the side panels are hidden in the immersive view, press **Enter** to show them.

## One-camera setup

1. Set **Punch-detection camera** to the laptop's built-in webcam and click **Connect laptop webcam**. Allow camera access when the browser asks.
2. Leave **Arm appearance → My live camera arms** and **Arm view → Laptop camera · front view** selected.
3. Keep your face, hands, and forearms visible with good lighting. Raise your guard and use **Calibrate guard position**.

Your real camera pixels appear over the head. This is the front view the laptop can see; a single front camera cannot show the backs of your arms from your own viewpoint. **Tracking wireframe** is an optional diagnostic display. **Captured 3D arms** uses an existing reconstructed arm capture.

## First-person setup with two cameras

The cameras have different jobs:

| Camera | Position and view | Job |
| --- | --- | --- |
| Laptop webcam | Near the on-screen head, facing you | Detects punches and maps impacts onto the head mesh |
| Phone or second webcam | Secured at upper chest level, landscape, facing forward toward the screen | Supplies the real arm pixels |

1. Connect the laptop camera first as above.
2. Connect a second camera that appears as a camera device on the Mac: a USB webcam, iPhone Continuity Camera, or a phone's supported USB webcam connection.
3. Click **Refresh camera list**. Choose **Arm view → Separate camera · first person**.
4. Select the second device under **Body / phone camera**, then click **Connect body camera**. The laptop device is excluded from this selector while in use.
5. Check the separate preview. Secure the camera away from your punch path and adjust its angle until both forearms enter at the bottom corners and your fists stay visible. The rear phone camera should look forward toward your arms and screen. The laptop preview should still show your face and hands.
6. Raise your guard and click **Calibrate guard position** for the laptop tracker. Try slow punches, then ordinary punches. The body feed changes appearance; the laptop feed remains responsible for scoring contacts.
7. Leave **Mirror body view** off unless the phone's webcam software already reverses the image. Disable Center Stage, Portrait, background replacement, or other effects that crop or remove your arms.

Each camera has its own disconnect button. Switching the arm view back to the laptop releases the body camera. Closing the page releases both feeds. No separate camera server or network stream URL is needed; opening `localhost:5173` on a phone does not connect its camera to the Mac app.

### iPhone on this Mac

Apple requires a compatible iPhone (XR or later, iOS 16+) and Mac (macOS Ventura 13+), the same Apple Account with two-factor authentication, and Wi-Fi and Bluetooth enabled. On the iPhone, enable **Settings → General → AirPlay & Continuity → Continuity Camera** (the menu may say **AirPlay & Handoff**). USB is supported; trust the Mac if prompted. Keep the iPhone locked and securely mounted in landscape. See [Apple's Continuity Camera setup and compatibility guide](https://support.apple.com/en-us/102546).

For Android or another phone, use its supported USB webcam mode or an existing webcam connection. There is no phone streaming receiver in this app. The device must appear in the browser's camera list first.

## Troubleshooting

- **Phone not listed:** connect or unlock it to establish trust, then lock it again for Continuity Camera; allow browser camera access, close other apps using it, and refresh the list.
- **Same camera in both views:** disconnect the body view, confirm the laptop's device selection, then select a different body device.
- **Arms missing:** use the raw preview to bring both fists into frame, improve lighting, and ensure body-camera forearms enter from the bottom corners. This placement also helps reject copies of your arms visible on the laptop screen.
- **Arms lag or edges flicker:** segmentation runs separately from punch detection, but the camera frame rate and inference speed still matter. Use steady lighting and close unused camera apps.
- **Front-facing hands instead of first person:** the arm source is still the laptop view; connect and select the body camera.

The arm view is a live 2D camera cutout adapted from Jace's `jace/cv` arm-mask and POV worker code (`d0c1763`). It preserves visible skin and sleeves, but does not reconstruct hidden surfaces or provide 3D depth occlusion against the head. Both video feeds are processed locally.
