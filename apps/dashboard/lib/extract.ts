/**
 * Pull plain text out of whatever a compliance team actually has.
 *
 * Policies do not arrive as markdown. They arrive as a handbook PDF, a Word
 * document from legal, or a paragraph in a text file. Requiring someone to
 * retype a rule into our format before the firewall can enforce it is the
 * friction that stops policies being configuration at all.
 *
 * Everything here runs server-side: these parsers are Node-only, and the file
 * never needs to reach the browser's bundle.
 */

/** Well beyond any real policy document, small enough that a bad upload cannot
 *  exhaust memory on the box running the demo. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** The prompt has to fit a context window, and a 200-page handbook is not a
 *  policy submission. Truncation is reported rather than silent. */
export const MAX_TEXT_CHARS = 60_000;

export type Extracted = { text: string; truncated: boolean; kind: string };

const EXT = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '');

export function isSupported(name: string, type: string): boolean {
  const e = EXT(name);
  return (
    ['txt', 'md', 'markdown', 'pdf', 'docx'].includes(e) ||
    type.startsWith('text/') ||
    type === 'application/pdf' ||
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

export async function extractText(file: {
  name: string;
  type: string;
  bytes: ArrayBuffer;
}): Promise<Extracted> {
  const ext = EXT(file.name);
  const buf = Buffer.from(file.bytes);
  let text: string;
  let kind: string;

  if (ext === 'pdf' || file.type === 'application/pdf') {
    kind = 'pdf';
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(file.bytes));
    const { text: pages } = await pdfText(doc, { mergePages: true });
    text = Array.isArray(pages) ? pages.join('\n') : pages;
  } else if (
    ext === 'docx' ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    kind = 'docx';
    const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
    const res = await (mammoth as { extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }> })
      .extractRawText({ buffer: buf });
    text = res.value;
  } else if (ext === 'doc') {
    // Legacy binary .doc is a different format entirely (OLE compound file),
    // not a docx. Say so instead of handing back mojibake that then gets
    // confidently turned into a "policy".
    throw new Error('legacy .doc is not supported — save it as .docx or paste the text');
  } else {
    kind = ext === 'md' || ext === 'markdown' ? 'markdown' : 'text';
    text = buf.toString('utf8');
  }

  text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (!text) {
    throw new Error(
      kind === 'pdf'
        ? 'no text found — this PDF is probably a scan, and OCR is not wired up'
        : 'the file contained no readable text',
    );
  }

  const truncated = text.length > MAX_TEXT_CHARS;
  return { text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated, kind };
}
