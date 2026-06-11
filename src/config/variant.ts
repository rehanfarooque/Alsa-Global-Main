const buildVariant = (() => {
  try {
    return import.meta.env?.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
})();

const VALID_VARIANTS = new Set(['full', 'tech', 'finance', 'commodity', 'energy', 'happy']);

function readStoredVariant(): string | null {
  try {
    const v = localStorage.getItem('alsaglobal-variant');
    return v && VALID_VARIANTS.has(v) ? v : null;
  } catch {
    return null;
  }
}

export const SITE_VARIANT: string = (() => {
  if (typeof window === 'undefined') return buildVariant;

  // AlsaGlobal is a single-deployment self-host: every variant runs from the
  // same origin and is selected purely by localStorage. The subdomain checks
  // below are only useful for the original worldmonitor.app multi-deployment
  // setup; on a self-host they would never match (the user's hostname is
  // arbitrary), which is why the variant switcher used to silently do nothing.
  //
  // Read order: localStorage first (works everywhere), then known subdomain
  // hint (worldmonitor.app legacy), then build-time default.
  const stored = readStoredVariant();
  if (stored) return stored;

  const h = location.hostname;
  if (h.startsWith('tech.'))      return 'tech';
  if (h.startsWith('finance.'))   return 'finance';
  if (h.startsWith('happy.'))     return 'happy';
  if (h.startsWith('commodity.')) return 'commodity';
  if (h.startsWith('energy.'))    return 'energy';

  return buildVariant;
})();
