/**
 * Text from a file as people actually save it: UTF-8 with or without a byte-order mark, UTF-16 (what Windows Notepad
 * calls "Unicode"), or an older Windows code page (Windows-1252) whose curly quotes are not valid UTF-8.
 */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) text = new TextDecoder('utf-8').decode(bytes.subarray(3));
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  else if (looksUtf16(bytes)) text = new TextDecoder(bytes[0] === 0 ? 'utf-16be' : 'utf-16le').decode(bytes);
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('windows-1252').decode(bytes);
    }
  }
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ') // non-breaking spaces copied from Word and web pages
    .replace(/[​-‍﻿]/g, '') // invisible characters
    .replace(/…/g, '...');
}

/** UTF-16 without a byte-order mark: English text has a zero in every other byte. */
function looksUtf16(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 400);
  if (n < 8) return false;
  let even = 0, odd = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) (i % 2 ? odd++ : even++);
  return Math.max(even, odd) > n / 4 && Math.min(even, odd) < n / 40;
}
