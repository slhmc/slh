Source: https://github.com/millida/launcher/tree/79c5ec2c9b76c3370d20407651e31a6774b2712d/src/vendor/mine3d
License: MIT, Copyright (c) 2026 Undefined Studio. See LICENSE.
SLH adaptation: disable built-in click nudge; home controls explicitly trigger animations.

SLH also guards late texture loads after disposal, releases scene geometry/materials, and exposes player hit testing for click-only emotions.

The skin3d dependency uses the pinned Three.js 0.182.0 instance through a scoped npm override, retaining the separate legacy skinview3d dependency.

SLH exposes the player in the pose hook for grounded standing poses. The home cycles all nine non-idle built-in animations; horizontal pinning follows LobbyCharacter.pinned from the same upstream commit. Millida service-only cosmetic model assets are not bundled.
