let schematicOpen = false;

export function isShipSchematicOpen(): boolean {
  return schematicOpen;
}

export function setShipSchematicOpen(open: boolean): void {
  schematicOpen = open;
}
