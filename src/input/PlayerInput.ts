/**
 * Input contract shared by local and remote players.
 * Production input is applied through keybindings/mouse; tests use MockPlayerInput.
 */
export interface PlayerInput {
  getThrusting(): boolean;
  getAngularVelocity(): number;
  getShooting(): boolean;
}
