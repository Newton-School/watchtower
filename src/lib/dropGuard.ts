/**
 * With Tauri's own file-drop handling off (so the reply box can take files),
 * a file dropped anywhere else would make the window open it in place of the
 * app. Drops the page doesn't take are refused instead.
 */
export function installDropGuard(target: Window = window): () => void {
  const refuse = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files') || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  };
  target.addEventListener('dragover', refuse);
  target.addEventListener('drop', refuse);
  return () => {
    target.removeEventListener('dragover', refuse);
    target.removeEventListener('drop', refuse);
  };
}
