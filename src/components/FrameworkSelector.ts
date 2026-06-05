import {
  type AnalysisPanelId,
  loadFrameworkLibrary,
  getActiveFrameworkForPanel,
  setActiveFrameworkForPanel,
} from '../services/analysis-framework-store';
import { PanelGateReason } from '../services/panel-gating';
import type { Panel } from './Panel';
import { t } from '../services/i18n';

interface FrameworkSelectorOptions {
  panelId: AnalysisPanelId;
  isPremium: boolean;
  panel: Panel | null;
  note?: string;
}

/**
 * Inline framework selector — renders a compact <select> directly in the
 * panel header (replaces the old gear-icon → popup pattern).
 * Always visible, no extra click required.
 */
export class FrameworkSelector {
  readonly el: HTMLElement;
  private select: HTMLSelectElement | null = null;
  private panelId: AnalysisPanelId;

  constructor(opts: FrameworkSelectorOptions) {
    this.panelId = opts.panelId;

    const wrapper = document.createElement('div');
    wrapper.className = 'framework-selector-inline';

    if (opts.isPremium) {
      const select = document.createElement('select');
      select.className = 'framework-inline-select';
      select.title = t('components.frameworkSelector.label');
      this.select = select;
      this.populateOptions(select);
      select.value = getActiveFrameworkForPanel(opts.panelId)?.id ?? '';

      select.addEventListener('change', () => {
        setActiveFrameworkForPanel(opts.panelId, select.value || null);
      });

      wrapper.appendChild(select);
    } else {
      const locked = document.createElement('button');
      locked.className = 'framework-inline-locked';
      locked.textContent = t('components.frameworkSelector.defaultNeutral');
      locked.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.panel?.showGatedCta(PanelGateReason.FREE_TIER, () => {});
      });
      wrapper.appendChild(locked);
    }

    this.el = wrapper;
  }

  private populateOptions(select: HTMLSelectElement): void {
    select.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = t('components.frameworkSelector.defaultNeutral');
    select.appendChild(defaultOpt);

    for (const fw of loadFrameworkLibrary()) {
      const opt = document.createElement('option');
      opt.value = fw.id;
      opt.textContent = fw.name;
      select.appendChild(opt);
    }
  }

  refresh(): void {
    if (!this.select) return;
    const current = this.select.value;
    this.populateOptions(this.select);
    this.select.value = getActiveFrameworkForPanel(this.panelId)?.id ?? current;
  }

  // no-op stubs kept for call-site compatibility
  destroy(): void {}
}
