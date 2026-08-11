import { useEffect, useState } from 'react';
import './Panels.css';

function formatDimensions(w) {
  return `${w.rows}×${w.cols}`;
}

function formatUpdatedAt(w) {
  if (!w.updatedAt) return '';
  return new Date(w.updatedAt).toLocaleString();
}

/**
 * Milestone 13: a library of named, saved warehouse layouts on top of
 * useSimulationGrid's existing "one record, create-or-update" sync - Save
 * As branches off a deliberately new record, Load replaces the current
 * grid with a previously saved one, and Delete removes it from the
 * server. All three reuse REST endpoints that already existed from
 * Milestone 3 (list/get/delete warehouses); this panel is what first
 * makes that browsing possible from the UI.
 */
export default function LayoutsPanel({
  layoutName,
  onChangeLayoutName,
  syncedWarehouseId,
  syncStatus,
  onSaveLayoutAs,
  savedLayouts,
  layoutsStatus,
  layoutsError,
  onRefreshLayouts,
  onLoadLayout,
  onDeleteLayout,
}) {
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    if (browsing) onRefreshLayouts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsing]);

  function handleSaveAs() {
    onSaveLayoutAs(layoutName);
  }

  function handleDelete(id, name) {
    if (window.confirm(`Delete saved layout "${name}"? This can't be undone.`)) {
      onDeleteLayout(id);
    }
  }

  return (
    <section className="panel">
      <p className="eyebrow">Saved Layouts</p>

      <label className="control-field control-field--wide">
        <span>Layout Name</span>
        <input
          type="text"
          value={layoutName}
          placeholder="Untitled Layout"
          onChange={(e) => onChangeLayoutName(e.target.value)}
        />
      </label>

      <div className="control-row">
        <button type="button" className="panel__button" onClick={handleSaveAs} disabled={syncStatus === 'syncing'}>
          {syncStatus === 'syncing' ? 'Saving…' : 'Save As New'}
        </button>
        <button type="button" className="panel__button" onClick={() => setBrowsing((b) => !b)}>
          {browsing ? 'Hide Browser' : 'Browse Saved'}
        </button>
      </div>

      {browsing ? (
        <div className="layout-browser">
          {layoutsStatus === 'loading' ? <p className="panel__empty-hint">Loading…</p> : null}
          {layoutsError ? <p className="panel__empty-hint panel__empty-hint--error">{layoutsError}</p> : null}
          {layoutsStatus === 'idle' && savedLayouts.length === 0 ? (
            <p className="panel__empty-hint">No saved layouts yet - use "Save As New" to create one.</p>
          ) : null}
          {savedLayouts.map((w) => (
            <div key={w._id} className={`layout-row${w._id === syncedWarehouseId ? ' layout-row--active' : ''}`}>
              <div className="layout-row__info">
                <span className="layout-row__name">{w.name}</span>
                <span className="layout-row__meta">
                  {formatDimensions(w)} · {formatUpdatedAt(w)}
                </span>
              </div>
              <div className="layout-row__actions">
                <button type="button" className="panel__button" onClick={() => onLoadLayout(w._id)}>
                  Load
                </button>
                <button
                  type="button"
                  className="panel__button panel__button--danger"
                  onClick={() => handleDelete(w._id, w.name)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
