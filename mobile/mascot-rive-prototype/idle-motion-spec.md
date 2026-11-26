# Idle motion brief

The rabbit is assembled from independent, transparent image parts to match the supplied reference: head, ears, body, front and back paws, tail, hair, scarf, eyes, and mouth. Parts are layered in `scene.rml` so they can move independently and later be replaced or refined.

- A three-second looping idle animation.
- Small body and head bob, a gentle head lean, ear flops, subtle paw/tail/hair/scarf motion.
- A brief blink swaps from `eyes_open.png` to `eyes_closed.png`.
- A brief cheerful expression swaps from `mouth_idle.png` to `mouth_happy.png`.
- Every part keeps its authored scale; animation changes position, rotation, and expression-layer opacity only.
- Preserve the cream, blush-pink, and warm golden-orange palette.
- No room, props, particles, text, reward effects, or app behavior.

The Rive project compiles and resolves 15 image layers. Visual capture is unavailable in the current environment because its graphics backend has no Metal support; inspect the scene by running `rive .` in this folder.
