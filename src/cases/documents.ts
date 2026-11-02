import { strFromU8, unzipSync } from 'fflate';

/**
 * Text from Word (.docx) and PDF files, laid out the way the use-case reader expects: one paragraph per line,
 * numbered and bulleted lists with their numbers ("1. ", "- "), and table rows with tabs between the cells.
 * These are untrusted uploads, so sizes are capped before anything is unpacked.
 */

export class DocumentError extends Error {}

const MAX_UNPACKED = 80 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_PAGES = 300;

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

/** True for a .docx (a zip file), as opposed to an old binary .doc. */
const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;

/** The text of one paragraph: runs, tabs and line breaks. Deleted text (tracked changes) is left out. */
function paragraphText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>/g)) {
    if (m[1] !== undefined) out += decode(m[1]);
    else if (m[0].startsWith('<w:tab')) out += '\t';
    else out += '\n';
  }
  return out.replace(/[  ]+/g, ' ');
}

/** How each list is numbered: numId → level → 'bullet' or a numbering format such as 'decimal'. */
function numberingFormats(xml: string): Map<string, Map<string, string>> {
  const abstract = new Map<string, Map<string, string>>();
  for (const a of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const levels = new Map<string, string>();
    for (const l of a[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) levels.set(l[1], l[2].match(/<w:numFmt\b[^>]*w:val="([^"]+)"/)?.[1] ?? 'decimal');
    abstract.set(a[1], levels);
  }
  const out = new Map<string, Map<string, string>>();
  for (const n of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const a = n[2].match(/<w:abstractNumId\b[^>]*w:val="(\d+)"/)?.[1];
    if (a && abstract.has(a)) out.set(n[1], abstract.get(a)!);
  }
  return out;
}

/** Reads a Word document (.docx). */
export function readDocx(data: Uint8Array): string {
  if (!isZip(data)) throw new DocumentError('This is an old Word file (.doc). Open it in Word and save it as .docx, or as PDF, then upload it again.');
  let entries = 0;
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) => {
        total += f.originalSize;
        if (++entries > MAX_ENTRIES || total > MAX_UNPACKED) throw new DocumentError('This Word file could not be read: it is damaged, or far too large. Open it in Word, save it again as .docx, and retry.');
        return f.name === 'word/document.xml' || f.name === 'word/numbering.xml';
      },
    });
  } catch (e) {
    if (e instanceof DocumentError) throw e;
    throw new DocumentError('This file could not be opened as a Word document. Save it again as .docx and retry.');
  }
  if (!files['word/document.xml']) throw new DocumentError('This file is not a Word document (no document text inside).');
  const doc = strFromU8(files['word/document.xml']);
  const formats = files['word/numbering.xml'] ? numberingFormats(strFromU8(files['word/numbering.xml'])) : new Map<string, Map<string, string>>();
  const body = doc.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? doc;
  const counters = new Map<string, number>();
  const lines: string[] = [];

  const paragraph = (p: string): string => {
    let text = paragraphText(p).trim();
    if (!text) return '';
    const numId = p.match(/<w:numPr>[\s\S]*?<w:numId\b[^>]*w:val="(\d+)"/)?.[1];
    const ilvl = p.match(/<w:numPr>[\s\S]*?<w:ilvl\b[^>]*w:val="(\d+)"/)?.[1] ?? '0';
    if (numId && numId !== '0') {
      const fmt = formats.get(numId)?.get(ilvl) ?? 'decimal';
      if (fmt === 'bullet' || fmt === 'none') text = `- ${text}`;
      else {
        const key = `${numId}:${ilvl}`;
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        // A new item at this level restarts the numbering of the levels under it.
        for (const k of counters.keys()) if (k.startsWith(`${numId}:`) && Number(k.split(':')[1]) > Number(ilvl)) counters.delete(k);
        text = `${fmt.startsWith('lower') ? String.fromCharCode(96 + Math.min(n, 26)) : fmt.startsWith('upper') ? String.fromCharCode(64 + Math.min(n, 26)) : n}. ${text}`;
      }
    }
    return text;
  };

  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const block = m[0];
    if (block.startsWith('<w:tbl')) {
      for (const row of block.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
        const cells = [...row[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map((c) => [...c[1].matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((p) => paragraphText(p[0]).trim()).filter(Boolean).join(' ').replace(/\t/g, ' '));
        if (cells.some(Boolean)) lines.push(cells.length > 1 ? cells.map((c) => c || '-').join('\t') : cells[0]);
      }
      lines.push('');
    } else {
      const text = paragraph(block);
      lines.push(...text.split('\n'));
    }
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new DocumentError('This Word document has no text in it.');
  return text;
}

/**
 * A PDF has no paragraphs, only lines, so a sentence that wraps arrives in pieces. A line that does not end a
 * sentence, followed by one that starts in lower case or with a quote, is the same sentence going on.
 */
function joinWrapped(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev !== undefined && !/[.:;!?)]$/.test(prev) && /^(?:[a-z]|["“'‘(])/.test(l) && !/^[a-z][.)]\s/.test(l)) out[out.length - 1] = `${prev} ${l}`;
    else out.push(l);
  }
  return out;
}

interface TextItem { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }

/** Reads a PDF. Text is put back into lines by its position on the page. */
export async function readPdf(data: Uint8Array): Promise<string> {
  if (!(data.length > 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46)) throw new DocumentError('This file is not a PDF.');
  const { getDocumentProxy } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/password/i.test(msg)) throw new DocumentError('This PDF is protected with a password. Save a copy without the password and upload that.');
    throw new DocumentError('This PDF could not be read. It may be damaged; try saving it again.');
  }
  const pages: string[] = [];
  try {
    for (let i = 1; i <= Math.min(pdf.numPages, MAX_PAGES); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      let lastY: number | undefined;
      let lastEnd: number | undefined;
      for (const raw of content.items as unknown[]) {
        const it = raw as TextItem;
        if (typeof it.str !== 'string') continue;
        const x = it.transform[4];
        const y = it.transform[5];
        const size = Math.abs(it.height || it.transform[3] || 10);
        const blank = !it.str.trim();
        if (!blank && lastY !== undefined && Math.abs(y - lastY) > size * 0.5) {
          lines.push(line);
          line = '';
          lastEnd = undefined;
        } else if (!blank && lastEnd !== undefined && line) {
          // A visible gap between two pieces on one line: a space, or a column break in a table.
          const gap = x - lastEnd;
          if (gap > size * 1.5) line = line.trimEnd() + '\t';
          else if (gap > size * 0.15 && !line.endsWith(' ') && !it.str.startsWith(' ')) line += ' ';
        }
        line += blank && line.endsWith(' ') ? '' : it.str;
        if (!blank) {
          // Spaces do not move the end of the text: a wide space item would hide a column gap.
          lastY = y;
          lastEnd = x + (it.width || 0);
        }
        if (it.hasEOL) {
          lines.push(line);
          line = '';
          lastY = undefined;
          lastEnd = undefined;
        }
      }
      if (line) lines.push(line);
      pages.push(joinWrapped(lines.map((l) => l.replace(/[  ]+/g, ' ').trim()).filter(Boolean)).join('\n'));
      page.cleanup();
    }
  } finally {
    const doc = pdf as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    await (doc.destroy ?? doc.cleanup)?.call(pdf).catch(() => undefined);
  }
  // Running headers, footers and page numbers repeat on every page; they are not part of the use case.
  const text = pages.join('\n\n').split('\n').filter((l) => !/^\s*(?:page\s+)?\d+\s*(?:(?:of|\/)\s*\d+)?\s*$/i.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new DocumentError('This PDF has no text in it: it looks like a scanned image. Upload the original Word file, or a PDF saved from it.');
  return text;
}
