import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import type { Bug } from './bugs.js';

/** One case of a test-case run, as the runner saved it (only what this needs). */
interface CaseShots {
  id: string;
  title: string;
  status: string;
  advice?: string;
  steps: { index: number; text: string; status: string; ms: number; error?: string; screenshot?: string; evidence?: string }[];
}

export interface EvidenceInput {
  runId: string;
  title: string;
  appUrl: string;
  startedAt: string;
  status: string;
  cases: CaseShots[];
  shotsDir: string;
  /** Bugs of the project that this run re-tested. */
  retested: Bug[];
  /** The cases and pictures folder of an earlier run, to find where a re-tested bug failed. */
  earlier: (runId: string) => { cases: CaseShots[]; shotsDir: string } | undefined;
}

/** A name that is safe as a file or folder on Windows, macOS and Linux, and short enough for Windows paths. */
const safe = (s: string, max: number) => {
  let t = s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > max) {
    // Cut at a whole word when one ends reasonably close to the limit.
    const cut = t.slice(0, max);
    const space = cut.lastIndexOf(' ');
    t = space > max * 0.6 ? cut.slice(0, space) : cut;
  }
  return t.replace(/[\s.,;:\-–]+$/, '') || 'untitled'; // Windows drops trailing dots and spaces; trailing commas look broken
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const csvCell = (v: unknown) => {
  const t = String(v ?? '');
  const x = /^[=+\-@]/.test(t) ? "'" + t : t; // a spreadsheet must not run it as a formula
  return /[",\n\r]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
};
const stamp = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
};
const ext = (f: string) => (f.match(/\.(png|jpe?g)$/i)?.[1] ?? 'png').toLowerCase();

/**
 * Every picture of a run, as a zip that unpacks into one folder: one sub-folder per test case with a picture per step in order,
 * a summary page that works offline, a CSV of the results and, for bugs this run re-tested, the picture from when the bug
 * failed beside the picture from the re-test.
 */
export function evidenceZip(input: EvidenceInput): { zip: Uint8Array; folder: string; pictures: number } {
  // Windows allows about 260 characters for a whole path, and "Extract All" puts everything in a folder named after the zip.
  // So: no extra folder inside the zip, and short names everywhere (zip 60, case folder 40, picture 45).
  const folder = `EasyTesting ${safe(input.title, 30)} ${stamp(input.startedAt)}`; // 12 + 30 + 17: the date and time always fit
  const files: Zippable = {};
  const add = (path: string, data: Uint8Array) => (files[path] = [data, { level: 0 }]); // pictures are already compressed
  const rows: unknown[][] = [['Test case', 'Title', 'Case result', 'Step no.', 'Step', 'Step result', 'Seconds', 'Error', 'Picture']];
  const html: string[] = [];
  let pictures = 0;

  for (const c of input.cases) {
    const dir = safe(`${c.id} ${c.title}`, 40);
    html.push(`<section><h2><span class="b ${esc(c.status)}">${esc(c.status)}</span> ${esc(c.id)} ${esc(c.title)}</h2>${c.advice ? `<p class="adv">${esc(c.advice)}</p>` : ''}<ol>`);
    for (const st of c.steps) {
      const shot = st.screenshot ?? st.evidence;
      let picture = '';
      if (shot && existsSync(join(input.shotsDir, shot))) {
        picture = `${dir}/${safe(`${String(st.index + 1).padStart(2, '0')} ${st.status === 'failed' ? 'FAILED' : st.status} - ${st.text}`, 45)}.${ext(shot)}`;
        add(picture, readFileSync(join(input.shotsDir, shot)));
        pictures++;
      }
      rows.push([c.id, c.title, c.status, st.index + 1, st.text, st.status, (st.ms / 1000).toFixed(1), st.error ?? '', picture]);
      html.push(`<li class="${esc(st.status)}"><div><b>${esc(st.status === 'failed' ? 'FAILED' : st.status)}</b> ${esc(st.text)}${st.error ? `<div class="err">${esc(st.error)}</div>` : ''}</div>${picture ? `<a href="${encodeURI(picture)}"><img src="${encodeURI(picture)}" alt="Step ${st.index + 1}" loading="lazy"></a>` : ''}</li>`);
    }
    html.push('</ol></section>');
  }

  // Re-test evidence: the bug as it was, and as it is now.
  const retestHtml: string[] = [];
  for (const bug of input.retested) {
    const caseId = bug.test.split(' ')[0];
    const now = input.cases.find((c) => c.id === caseId);
    const dir = `Re-tests/${safe(`${bug.id} ${bug.test}`, 30)}`;
    const result = bug.retest?.result === 'passed' ? 'passed' : 'failed';
    const lastPicture = (c: CaseShots | undefined) => [...(c?.steps ?? [])].reverse().map((s) => s.screenshot ?? s.evidence).find(Boolean);
    const after = lastPicture(now);
    const parts: string[] = [];
    if (after && existsSync(join(input.shotsDir, after))) {
      const name = `${dir}/2 after - ${result} ${input.runId.slice(0, 6)}.${ext(after)}`;
      add(name, readFileSync(join(input.shotsDir, after)));
      parts.push(`<figure><a href="${encodeURI(name)}"><img src="${encodeURI(name)}" alt="After"></a><figcaption>After: re-test ${result} (this run)</figcaption></figure>`);
      pictures++;
    }
    // The newest earlier run, still on the server, where this bug failed and left a picture.
    const failedIn = [...bug.history].reverse().filter((h) => h.runId && h.runId !== input.runId && /found|fail/i.test(h.event)).map((h) => h.runId!);
    for (const runId of new Set(failedIn)) {
      const old = input.earlier(runId);
      const failed = old?.cases.find((c) => c.id === caseId)?.steps.find((s) => s.status === 'failed' && s.screenshot);
      if (!old || !failed?.screenshot || !existsSync(join(old.shotsDir, failed.screenshot))) continue;
      const name = `${dir}/1 before - failed ${runId.slice(0, 6)}.${ext(failed.screenshot)}`;
      add(name, readFileSync(join(old.shotsDir, failed.screenshot)));
      parts.unshift(`<figure><a href="${encodeURI(name)}"><img src="${encodeURI(name)}" alt="Before"></a><figcaption>Before: failed in run ${esc(runId)}${failed.error ? ` — ${esc(failed.error)}` : ''}</figcaption></figure>`);
      pictures++;
      break;
    }
    retestHtml.push(`<section class="rt"><h2><span class="b ${result}">re-test ${result}</span> ${esc(bug.id)} ${esc(bug.test)}</h2><div class="pair">${parts.join('') || '<p>No pictures were kept for this bug.</p>'}</div></section>`);
  }

  const counts = ['passed', 'failed', 'blocked', 'skipped'].map((s) => [s, input.cases.filter((c) => c.status === s).length] as const).filter(([, n]) => n);
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(input.title)} - EasyTesting evidence</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:24px;color:#17201b;background:#f6f8f7}h1{margin:0}h2{font-size:17px;margin:0 0 8px}.meta{color:#5d6b63}section{background:#fff;border:1px solid #dfe6e2;border-radius:12px;padding:16px;margin-top:16px}ol{padding-left:22px;margin:0}li{margin:10px 0;display:grid;gap:8px}li img,figure img{max-width:100%;width:520px;border:1px solid #dfe6e2;border-radius:8px}.b{display:inline-block;font-size:12px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:99px;background:#eef2ef;margin-right:6px}.b.passed{background:#e3f5ea;color:#1b7f4d}.b.failed{background:#fde8e6;color:#b3261e}.b.blocked{background:#fdf1da;color:#9a5b00}li.failed>div>b{color:#b3261e}.err{color:#b3261e;font-size:14px}.adv{color:#5d6b63}.pair{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0;flex:1 1 320px}figcaption{font-size:13px;color:#5d6b63}</style></head><body>
<h1>${esc(input.title)}</h1><p class="meta">Run ${esc(input.runId)} · ${esc(new Date(input.startedAt).toLocaleString())} · ${esc(input.appUrl)} · ${esc(input.status)} · ${counts.map(([s, n]) => `${n} ${s}`).join(', ')} · ${pictures} pictures</p>
${retestHtml.length ? `<h1 style="font-size:22px;margin-top:24px">Re-test evidence</h1>${retestHtml.join('')}<h1 style="font-size:22px;margin-top:24px">Every test case</h1>` : ''}${html.join('')}
<p class="meta">Made by EasyTesting. The pictures are in the folders next to this page; results.csv has the same results for a spreadsheet.</p></body></html>`;
  files['Open me - summary.html'] = new TextEncoder().encode(page);
  files['results.csv'] = new TextEncoder().encode('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  return { zip: zipSync(files), folder, pictures };
}
