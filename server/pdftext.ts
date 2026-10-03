import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from '../src/calc/payslip';

/** Текст первой страницы PDF с координатами. */
export async function extractItems(data: Uint8Array): Promise<TextItem[]> {
  const task = getDocument({ data, useSystemFonts: false, disableFontFace: true });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(1);
    const tc = await page.getTextContent();
    return tc.items
      .filter((i): i is typeof i & { str: string; transform: number[] } => 'str' in i && i.str.trim() !== '')
      .map((i) => ({ s: i.str, x: Math.round(i.transform[4]), y: Math.round(i.transform[5]) }));
  } finally {
    await task.destroy();
  }
}
