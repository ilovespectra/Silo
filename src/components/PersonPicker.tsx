import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FiSlash, FiUser, FiUserCheck, FiUserPlus } from "react-icons/fi";

interface PersonPickerProps {
  photoPaths: string[];
  anchor: { x: number; y: number };
  onClose: () => void;
  onAdded?: (result: {
    people: PersonSummary[];
    personId: string;
    personName: string;
    count: number;
  }) => void;
  /** Pick mode: called with the chosen person instead of adding photos; hides "New person". */
  onPick?: (person: PersonSummary) => void;
  title?: string;
  pickLabel?: string;
  excludeIds?: string[];
}

/** Popup for adding photos to an existing person or a new one; loads the people list itself. */
export default function PersonPicker({
  photoPaths,
  anchor,
  onClose,
  onAdded,
  onPick,
  title,
  pickLabel = "Merge into",
  excludeIds = [],
}: PersonPickerProps) {
  const electronAPI = window.electron;
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void electronAPI?.getFaceState().then((state) => setPeople(state.people));
  }, [electronAPI]);

  const matches = useMemo(() => {
    const clean = query.trim().toLowerCase();
    return people
      .filter((person) => !excludeIds.includes(person.id))
      .filter((person) => !clean || person.name.toLowerCase().includes(clean))
      .sort(
        (first, second) =>
          Number(first.status === "banned") -
            Number(second.status === "banned") ||
          Number(second.status === "confirmed") -
            Number(first.status === "confirmed") ||
          Number(/^Person \d+$/.test(first.name)) -
            Number(/^Person \d+$/.test(second.name)) ||
          second.photoCount - first.photoCount,
      )
      .slice(0, 300);
  }, [excludeIds, people, query]);

  const add = async (target: { personId?: string; newName?: string }) => {
    if (!electronAPI) return;
    setBusy(true);
    setError("");
    try {
      const result = await electronAPI.addPhotosToPerson(photoPaths, target);
      onAdded?.({ ...result, count: photoPaths.length });
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.replace(
              /^Error invoking remote method '[^']+': (Error: )?/,
              "",
            )
          : "Could not add photos.",
      );
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="photo-context-backdrop"
      onMouseDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className="photo-context-menu person-picker"
        role="menu"
        style={{
          left: Math.max(8, Math.min(anchor.x, window.innerWidth - 290)),
          top: Math.max(8, Math.min(anchor.y, window.innerHeight - 440)),
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          {title ??
            `Add ${photoPaths.length.toLocaleString()} photo${photoPaths.length === 1 ? "" : "s"} to person`}
        </header>
        {newName === null ? (
          <>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") onClose();
              }}
              placeholder="Search people"
            />
            {!onPick && (
              <button
                className="photo-context-new"
                role="menuitem"
                disabled={busy}
                onClick={() => setNewName(query.trim())}
              >
                <FiUserPlus /> New person…
              </button>
            )}
            <span className="photo-context-label">
              {onPick ? pickLabel : "Existing people"}
            </span>
            <div className="photo-context-list">
              {matches.map((person) => (
                <button
                  key={person.id}
                  role="menuitem"
                  className={person.status === "banned" ? "banned" : undefined}
                  title={
                    person.status === "banned"
                      ? "Banned person: added photos will be hidden across Silo"
                      : undefined
                  }
                  disabled={busy}
                  onClick={() => {
                    if (onPick) {
                      onPick(person);
                      onClose();
                    } else {
                      void add({ personId: person.id });
                    }
                  }}
                >
                  <span className="photo-context-avatar">
                    {person.coverCropUrl ? (
                      <img src={person.coverCropUrl} alt="" />
                    ) : (
                      <FiUser />
                    )}
                  </span>
                  <span className="photo-context-name">{person.name}</span>
                  {person.status === "confirmed" && <FiUserCheck />}
                  {person.status === "banned" && <FiSlash />}
                  <small>{person.photoCount.toLocaleString()}</small>
                </button>
              ))}
              {matches.length === 0 && (
                <p className="photo-context-empty">No matching people.</p>
              )}
            </div>
          </>
        ) : (
          <form
            className="photo-context-create"
            onSubmit={(event) => {
              event.preventDefault();
              if (newName.trim()) void add({ newName });
            }}
          >
            <input
              autoFocus
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setNewName(null);
              }}
              placeholder="Person name"
            />
            <button
              type="submit"
              className="photo-context-new"
              disabled={busy || !newName.trim()}
            >
              <FiUserPlus /> Create & add
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setNewName(null)}
            >
              Back
            </button>
          </form>
        )}
        {error && (
          <p className="photo-context-error">
            <FiSlash /> {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
