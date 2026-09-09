import { memo, useEffect, useId, useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '../common/Feedback.jsx';
import { LAYOUTS_STATUS, SYNC_STATUS } from '../../state/useSimulationGrid.js';
import { formatDateTime, formatDimensions } from '../../utils/format.js';
import './Panels.css';

/**
 * A library of named, saved warehouse layouts on top of useSimulationGrid's
 * "one record, create-or-update" sync: Save As branches off a deliberately
 * new record, Load replaces the current grid with a previously saved one,
 * and Delete removes it from the server.
 *
 * Delete confirms inline rather than through `window.confirm`. A native
 * modal blocks the whole page (including the live simulation behind it),
 * cannot be styled, is announced inconsistently by screen readers, and is
 * unavailable in the test environment - so the destructive action that most
 * needed a test was the one that could not have one.
 */
function LayoutsPanel({
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
  deletingLayoutId,
}) {
  const headingId = useId();
  const nameId = useId();
  const [browsing, setBrowsing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(null);

  useEffect(() => {
    if (browsing) onRefreshLayouts();
  }, [browsing, onRefreshLayouts]);

  const isSaving = syncStatus === SYNC_STATUS.SYNCING;
  const isLoadingList = layoutsStatus === LAYOUTS_STATUS.LOADING;

  async function handleDelete(id) {
    setConfirmingDelete(null);
    await onDeleteLayout(id);
  }

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 className="eyebrow panel__heading" id={headingId}>
        Saved Layouts
      </h2>

      <div className="control-field control-field--wide">
        <label htmlFor={nameId}>Layout Name</label>
        <input
          id={nameId}
          type="text"
          value={layoutName}
          placeholder="Untitled Layout"
          maxLength={80}
          onChange={(e) => onChangeLayoutName(e.target.value)}
        />
      </div>

      <div className="control-row">
        <button
          type="button"
          className="panel__button"
          onClick={() => onSaveLayoutAs(layoutName)}
          disabled={isSaving}
          aria-busy={isSaving}
        >
          {isSaving ? 'Saving…' : 'Save As New'}
        </button>
        <button
          type="button"
          className="panel__button"
          onClick={() => setBrowsing((value) => !value)}
          aria-expanded={browsing}
        >
          {browsing ? 'Hide Browser' : 'Browse Saved'}
        </button>
      </div>

      {browsing ? (
        <div className="layout-browser">
          {isLoadingList && savedLayouts.length === 0 ? <LoadingState label="Loading saved layouts…" /> : null}

          {layoutsError ? <ErrorState message={layoutsError} onRetry={onRefreshLayouts} /> : null}

          {!isLoadingList && !layoutsError && savedLayouts.length === 0 ? (
            <EmptyState
              title="No saved layouts yet."
              hint='Give this layout a name above and use "Save As New" to keep it.'
            />
          ) : null}

          {savedLayouts.map((warehouse) => {
            const isActive = warehouse._id === syncedWarehouseId;
            const isDeleting = deletingLayoutId === warehouse._id;
            const isConfirming = confirmingDelete === warehouse._id;

            return (
              <div
                key={warehouse._id}
                className={`layout-row${isActive ? ' layout-row--active' : ''}`}
              >
                <div className="layout-row__info">
                  <span className="layout-row__name">
                    {warehouse.name}
                    {isActive ? <span className="layout-row__badge">Open</span> : null}
                  </span>
                  <span className="layout-row__meta">
                    {formatDimensions(warehouse)} · {formatDateTime(warehouse.updatedAt)}
                  </span>
                </div>

                {isConfirming ? (
                  <div className="layout-row__actions">
                    <span className="layout-row__confirm">Delete?</span>
                    <button
                      type="button"
                      className="panel__button panel__button--danger"
                      onClick={() => handleDelete(warehouse._id)}
                      disabled={isDeleting}
                    >
                      {isDeleting ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button
                      type="button"
                      className="panel__button"
                      onClick={() => setConfirmingDelete(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="layout-row__actions">
                    <button
                      type="button"
                      className="panel__button"
                      onClick={() => onLoadLayout(warehouse._id)}
                      disabled={isSaving}
                    >
                      Load
                    </button>
                    <button
                      type="button"
                      className="panel__button panel__button--danger"
                      onClick={() => setConfirmingDelete(warehouse._id)}
                      aria-label={`Delete layout ${warehouse.name}`}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

export default memo(LayoutsPanel);
