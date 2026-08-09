type OverlayHitDocument = Pick<Document, "elementFromPoint">;

export function isOverlayHitAtPoint(
  documentRef: OverlayHitDocument,
  clientX: number,
  clientY: number,
) {
  return Boolean(
    documentRef
      .elementFromPoint(clientX, clientY)
      ?.closest("[data-overlay-hit]"),
  );
}

export function shouldOverlayAcceptMouse(
  settingsOpen: boolean,
  documentRef: OverlayHitDocument,
  clientX: number,
  clientY: number,
) {
  if (settingsOpen) return true;
  const element = documentRef.elementFromPoint(clientX, clientY);
  if (element?.closest("[data-overlay-settings]")) return false;
  return Boolean(element?.closest("[data-overlay-hit]"));
}
