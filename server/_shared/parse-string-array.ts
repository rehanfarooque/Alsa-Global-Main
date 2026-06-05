/**
 * Defensive parser for repeated-string query params.
 * Some codegen paths may pass comma-separated strings into string[] fields.
 */
export function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    // params.getAll() may return ["A,B,C"] — split commas within each element
    return raw.flatMap((item) =>
      typeof item === 'string' && item.length > 0 ? item.split(',').map((s) => s.trim()).filter(Boolean) : [],
    );
  }
  if (typeof raw === 'string' && raw.length > 0) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
