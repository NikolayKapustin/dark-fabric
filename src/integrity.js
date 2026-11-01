import { createHash } from 'node:crypto';
export function qualityDigest(bytes) {
  // Git may check out the same text blob as LF or CRLF on Windows.
  // Preserve binary bytes; canonicalize only valid UTF-8 text without NULs.
  const text=bytes.toString('utf8');
  const content=!bytes.includes(0)&&Buffer.from(text,'utf8').equals(bytes)?text.replace(/\r\n/g,'\n'):bytes;
  return createHash('sha256').update(content).digest('hex');
}
