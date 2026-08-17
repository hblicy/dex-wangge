function sanitize(value) {
  let text = String(value ?? '');
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return '[REDACTED_URL]';
    }
  });
  return text.replace(/0x[0-9a-f]{40,64}/gi, '[REDACTED_HEX]');
}

export function describeError(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; current != null && depth < 5 && !seen.has(current); depth += 1) {
    if ((typeof current === 'object' || typeof current === 'function') && current !== null) seen.add(current);
    const name = sanitize(current?.name || current?.constructor?.name || typeof current);
    const code = current?.code == null ? '' : ` [${sanitize(current.code)}]`;
    const message = sanitize(current?.message ?? current);
    parts.push(`${name}${code}: ${message}`);
    current = current?.cause;
  }
  return parts.join(' <- ');
}
