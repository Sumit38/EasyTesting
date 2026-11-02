import { strToU8, zipSync } from 'fflate';

/**
 * A small Word (.docx) writer: headings, paragraphs, bullet lists and tables, with a header and page numbers.
 * Hand-written WordprocessingML on fflate, like the .xlsx writer, so no Office library is needed.
 */

export interface Run { text: string; bold?: boolean; italic?: boolean }
type Text = string | Run[];

export type Block =
  | { kind: 'title' | 'subtitle' | 'h1' | 'h2' | 'h3'; text: string }
  | { kind: 'p'; text: Text; muted?: boolean }
  | { kind: 'bullets'; items: Text[] }
  | { kind: 'table'; header: string[]; rows: string[][]; widths?: number[]; keyColumn?: boolean }
  | { kind: 'pagebreak' };

export interface DocxOptions {
  title: string;
  /** Shown at the top of every page after the first. */
  header?: string;
  author?: string;
}

const BRAND = '2F7D57';
const PAGE_WIDTH = 11906; // A4, in twentieths of a point
const PAGE_HEIGHT = 16838;
const MARGIN = 1134; // 2 cm
const CONTENT = PAGE_WIDTH - 2 * MARGIN;

const esc = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** One run; line breaks inside the text become Word line breaks. */
function run(r: Run): string {
  const props = (r.bold ? '<w:b/>' : '') + (r.italic ? '<w:i/>' : '');
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : '';
  return String(r.text)
    .split('\n')
    .map((line, i) => `<w:r>${rPr}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`)
    .join('');
}
const runs = (t: Text) => (typeof t === 'string' ? run({ text: t }) : t.map(run).join(''));
const para = (t: Text, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs(t)}</w:p>`;

function table(b: Extract<Block, { kind: 'table' }>): string {
  const n = b.header.length;
  const weights = b.widths && b.widths.length === n ? b.widths : Array(n).fill(1);
  const sum = weights.reduce((a, w) => a + w, 0);
  const cols = weights.map((w) => Math.max(500, Math.floor((CONTENT * w) / sum)));
  const border = `<w:top w:val="single" w:sz="4" w:color="C9D3CD"/><w:left w:val="single" w:sz="4" w:color="C9D3CD"/><w:bottom w:val="single" w:sz="4" w:color="C9D3CD"/><w:right w:val="single" w:sz="4" w:color="C9D3CD"/><w:insideH w:val="single" w:sz="4" w:color="C9D3CD"/><w:insideV w:val="single" w:sz="4" w:color="C9D3CD"/>`;
  const cell = (text: string, i: number, head: boolean, zebra: boolean) => {
    const shade = head ? `<w:shd w:val="clear" w:color="auto" w:fill="${BRAND}"/>` : zebra ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F6F3"/>' : '';
    const lines = String(text ?? '').split('\n');
    const bold = head || (b.keyColumn && i === 0);
    const paras = lines.map((l) => `<w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr>${l ? `<w:r>${head ? '<w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>' : bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(l)}</w:t></w:r>` : ''}</w:p>`).join('');
    return `<w:tc><w:tcPr><w:tcW w:w="${cols[i]}" w:type="dxa"/>${shade}</w:tcPr>${paras}</w:tc>`;
  };
  // A table whose header is all blank (a list of label and value) has no header row.
  const head = b.header.some(Boolean) ? `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${b.header.map((h, i) => cell(h, i, true, false)).join('')}</w:tr>` : '';
  const body = b.rows.map((r, ri) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${Array.from({ length: n }, (_, i) => cell(r[i] ?? '', i, false, ri % 2 === 1)).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${CONTENT}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${head}${body}</w:tbl><w:p><w:pPr><w:spacing w:after="60"/></w:pPr></w:p>`;
}

function block(b: Block): string {
  switch (b.kind) {
    case 'title': return para(b.text, '<w:pStyle w:val="Title"/>');
    case 'subtitle': return para(b.text, '<w:pStyle w:val="Subtitle"/>');
    case 'h1': return para(b.text, '<w:pStyle w:val="Heading1"/>');
    case 'h2': return para(b.text, '<w:pStyle w:val="Heading2"/>');
    case 'h3': return para(b.text, '<w:pStyle w:val="Heading3"/>');
    case 'p': return para(b.text, b.muted ? '<w:pStyle w:val="Note"/>' : '');
    case 'bullets': return b.items.map((t) => para(t, '<w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')).join('');
    case 'table': return table(b);
    case 'pagebreak': return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const STYLES = `${XML}<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="1800" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="${BRAND}"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="480"/></w:pPr><w:rPr><w:color w:val="555555"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="${BRAND}"/></w:pBdr><w:spacing w:before="360" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="${BRAND}"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4E3A"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Note"><w:name w:val="Note"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:color w:val="666666"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="777777"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="777777"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr></w:style>
</w:styles>`;

const NUMBERING = `${XML}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="260"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:color w:val="${BRAND}"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

/** A .docx file made of the given blocks. */
export function writeDocx(blocks: Block[], opts: DocxOptions): Uint8Array {
  const body = blocks.map(block).join('');
  const sect = `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="567" w:footer="567" w:gutter="0"/><w:titlePg/></w:sectPr>`;
  const header = `${XML}<w:hdr ${W}>${para(opts.header ?? opts.title, '<w:pStyle w:val="Header"/>')}</w:hdr>`;
  const footer = `${XML}<w:ftr ${W}><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> of </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    '_rels/.rels': strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'docProps/core.xml': strToU8(`${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(opts.title)}</dc:title><dc:creator>${esc(opts.author || 'EasyTesting')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`),
    'word/_rels/document.xml.rels': strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`),
    'word/document.xml': strToU8(`${XML}<w:document ${W}><w:body>${body}${sect}</w:body></w:document>`),
    'word/styles.xml': strToU8(STYLES),
    'word/numbering.xml': strToU8(NUMBERING),
    'word/header1.xml': strToU8(header),
    'word/footer1.xml': strToU8(footer),
  };
  return zipSync(files);
}
