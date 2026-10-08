import { Box3 } from "three";
import type { PlayerObject } from "skin3d";

/** Millida pins horizontal motion; standing poses also keep a foot on the floor. */
export function stabilizeHomePose(player: PlayerObject, standing: boolean, bounds: Box3): void {
  player.position.x = 0;
  player.position.z = 0;
  if (!standing) return; // Preserve deliberate jumps, steps and the flying pose.
  player.updateWorldMatrix(true, true);
  bounds.makeEmpty().expandByObject(player.skin.leftLeg).expandByObject(player.skin.rightLeg);
  if (Number.isFinite(bounds.min.y)) player.position.y += -16 - bounds.min.y;
}

export function homePoseBounds(): Box3 { return new Box3(); }
