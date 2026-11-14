# Aim Training for 8 Ball Pool (Android)

Independent Android project stored under `aim-training-android/` in the Differ repository. It does not import, edit, or execute Differ code.

## Current implementation
- Android launcher for Android 8+ (tested build target Android 13 compatible).
- User-approved Android overlay permission flow.
- Movable floating training panel.
- On-screen practice guide line with angle adjustment and show/hide controls.
- Close control; no automated aiming, touching, or shooting in 8 Ball Pool.

## Important status
This is the first buildable implementation, **not the promised full automatic ball-recognition release**. It does not yet detect balls, pockets, rails, cue-ball position, or calculate bank shots from the live game screen. Those features require MediaProjection capture, computer-vision work, and real-device validation on the Galaxy A14 4G. Do not treat the guide line as an automatically aligned shot prediction.

## Build
GitHub Actions workflow: `.github/workflows/build-apk.yml` (repository path: `aim-training-android/.github/workflows/build-apk.yml`). Run it manually from Actions or push a change under this folder. The APK is uploaded as `aim-training-debug-apk`.
