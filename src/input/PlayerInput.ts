/**
 * Input contract shared by local players, remote players, and bots.
 * Production input is applied through keybindings/mouse; tests use MockPlayerInput.
 */
export interface PlayerInput {
  getThrusting(): boolean;
  getAngularVelocity(): number;
  getShooting(): boolean;
}
