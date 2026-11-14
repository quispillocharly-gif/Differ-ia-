# Aim Training FULL – Android
Independent app in `aim-training-android/`; it does not edit or execute Differ.

Included: Android MediaProjection capture consent and foreground service; movable floating overlay; live green-table segmentation and heuristic ball-candidate detection; cue candidate and target guidance line; angle adjustment and show/hide controls. It does not automate game input, aiming, or shooting.

Accuracy: computer vision is heuristic and depends on table color, resolution, animation, shadows, and layout. It is not a guaranteed solver. It needs validation against actual Galaxy A14 gameplay. White highlights can be confused with the cue ball; reflections and rails can create false candidates. Pocket recognition, calibrated bank-shot geometry, collision physics and pocket selection are not yet validated.