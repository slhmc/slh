# Home character resource changes (2026-10-15)

Follow-up: the narrow canvas below was reverted after it visibly clipped the
soft contact shadow. Home now uses the full stage width. The pixel reduction
and final benchmark below describe the earlier build, not the corrected build.
The WebView2 resource-settings panel and native process restrictions were also
removed. Previously saved policies are preserved as legacy data and do not
limit FPS, CPU affinity or working set. Ordinary minimize/suspend still works.

The home character keeps the selected frame rate, native pixel density, materials,
lighting, shadows and idle animation. Resource limits remain optional.

Changes:

- Center a viewport at most 0.6 times the stage height instead of allocating a
  full-width transparent WebGL canvas. At a 2560 × 1356 native window and 175%
  scaling, the drawing buffer changes from 827 × 1027 to 617 × 1027: 25.4% fewer
  pixels. Camera framing preserves the standing character's displayed size.
- Compact position, normal and UV buffers when hidden voxel faces are removed.
  The retained triangles, normals and UV coordinates are unchanged.
- Sample the completed PMREM environment through a plain half-float texture,
  freeing the temporary framebuffer and depth attachment. Keep the existing
  fallback on devices that cannot read half-float textures.

Experiments combining opaque meshes and reusing shadow maps were excluded:
fewer draws did not establish a consistent improvement in whole-process CPU.
The default native minimize/suspend lifecycle is preserved. Forced working-set
trimming and additional background scene destruction are not enabled.

Verification:

- UI audit: 1472 catalog entries passed.
- Frontend production build passed; 31 unit-test files / 112 tests passed.
- Real WebGL Playwright checks passed for classic/slim skins, voxel overlays,
  framing, shadows, PMREM pixel equivalence and shared LUT listener cleanup.
  Viewport comparisons differed by at most three significant color channels
  out of 1,536,000 channels on the tested GPU.
- Playwright resource-settings controls passed.
- Native host Rust tests: 13 passed. Core: 129 passed, 2 ignored tests requiring
  external fixtures.

Native measurements use `scripts/benchmark-home-native.mjs` and
`scripts/measure-launcher.ps1`. They run against isolated data, with an offline
account, unlimited character FPS, disabled resource limits and a foreground
window. Memory is private working set summed across SLH and its WebView2
descendants; summing total working sets would count shared pages repeatedly.
Raw samples, executable hashes, runtime versions and screenshots are saved under
`artifacts/performance/` and excluded from Git.

Repeated native experiments showed substantial CPU variation even when switching
back to the original renderer. A fixed CPU reduction must not be inferred from
those trials. The verified reduction is in allocated/rendered pixels and unused
graphics buffers. An active-window budget of 100–120 MiB has not been achieved;
WebView2 plus the launcher used roughly 155–165 MiB in these experiments.

The final sequential isolated-profile measurement (GTX 1650, WebView2
155.0.4283.45, 8 logical processors, 175% scaling, 30-second samples) was:

| State | Original | Final |
| --- | ---: | ---: |
| Foreground CPU, average | 0.83% | 0.47% |
| Foreground private working set, average | 159.68 MiB | 157.72 MiB |
| Actual rendered FPS | 144 | 144 |

The final build also measured 0% CPU and 19.46 MiB private working set after
minimizing. Quick restore retained the warm scene; long restore retained its
canvas and restored a usable WebGL context. The earlier controlled original
build's minimized measurement was 0% / 22.77 MiB. These are test-profile
measurements, not a guarantee for every account skin or machine.

Only `E:/SLH/SLH.exe` was replaced after validation. The original is saved at
`E:/SLH/launcher-backups/SLH-before-home-optimization-20261015.exe`. Hash checks
confirmed that the database, account files and language files were unchanged
during replacement. Installed FPS remains unlimited and resource limits remain
disabled. Normal application startup was restored after replacement.
