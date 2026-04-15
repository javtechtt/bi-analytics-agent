/**
 * Visual export utility.
 * Captures DOM elements as high-resolution PNGs for download.
 * Hides elements marked with data-export-hidden during capture.
 */

import { toPng } from "html-to-image";

/** Export a DOM element as a PNG download.
 *  Elements with [data-export-hidden] are hidden during capture. */
export async function exportToPng(
  element: HTMLElement,
  filename: string
): Promise<void> {
  // Wait a tick to ensure charts/recharts are fully rendered
  await new Promise((r) => setTimeout(r, 200));

  const dataUrl = await toPng(element, {
    pixelRatio: 3, // 3x for presentation-quality output
    backgroundColor: "#060918",
    style: {
      overflow: "visible",
    },
    filter: (node) => {
      // Hide elements marked for export exclusion
      if (node instanceof HTMLElement && node.dataset.exportHidden != null) {
        return false;
      }
      return true;
    },
  });

  const link = document.createElement("a");
  link.download = `${filename}.png`;
  link.href = dataUrl;
  link.click();
}
