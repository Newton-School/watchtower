import { useEffect, useRef } from 'react';

// Open layers (a prompt, a picker, a suggestion list), newest last.
const layers: Array<{ close: () => void }> = [];

/**
 * One Escape closes the newest open layer, and nothing else sees it: not an
 * older layer, not the field it was typed in, not the page. Caught on the
 * window in the capture phase, because WebKit leaves focus on the page after
 * a click, so the key can come from anywhere.
 */
function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.isComposing) return;
  const top = layers[layers.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  top.close();
}

/** While `active`, Escape calls `close` before anything opened earlier. */
export function useEscapeLayer(active: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return;
    const layer = { close: () => closeRef.current() };
    if (layers.length === 0) window.addEventListener('keydown', onKeyDown, true);
    layers.push(layer);
    return () => {
      const at = layers.indexOf(layer);
      if (at >= 0) layers.splice(at, 1);
      if (layers.length === 0) window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [active]);
}
