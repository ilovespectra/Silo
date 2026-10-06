import React, { useEffect, useState } from "react";
import { FiMapPin, FiSearch, FiX } from "react-icons/fi";

interface LocationPickerProps {
  files: FileInfo[];
  onAssigned: (result: GeoAssignmentResult) => void;
  onClose?: () => void;
}

function countryFlag(countryCode: string | null) {
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) return "";
  return String.fromCodePoint(
    ...countryCode.split("").map((letter) => 127397 + letter.charCodeAt(0)),
  );
}

export default function LocationPicker({
  files,
  onAssigned,
  onClose,
}: LocationPickerProps) {
  const electronAPI = window.electron;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoLocationSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const normalized = query.trim();
    if (!electronAPI || normalized.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setError("");
    const timer = window.setTimeout(() => {
      void electronAPI
        .searchLocations(normalized)
        .then((suggestions) => {
          if (!cancelled) setResults(suggestions);
        })
        .catch(() => {
          if (!cancelled)
            setError("Location search is temporarily unavailable.");
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [electronAPI, query]);

  const assign = async (location: GeoLocationSuggestion) => {
    if (!electronAPI || files.length === 0) return;
    setSaving(true);
    setError("");
    try {
      onAssigned(await electronAPI.setGeoLocation(files, location));
      setQuery("");
      setResults([]);
      onClose?.();
    } catch {
      setError("The selected location could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!electronAPI || files.length === 0) return;
    setSaving(true);
    setError("");
    try {
      onAssigned(
        await electronAPI.clearGeoLocation(files.map((file) => file.path)),
      );
      onClose?.();
    } catch {
      setError("The manual location could not be removed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="location-picker" aria-label="Assign verified location">
      <header>
        <div>
          <strong>
            <FiMapPin /> Assign location
          </strong>
          <span>
            {files.length} selected item{files.length === 1 ? "" : "s"}
          </span>
        </div>
        {onClose && (
          <button onClick={onClose} title="Close location search">
            <FiX />
          </button>
        )}
      </header>
      <label>
        <FiSearch />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search city, region, landmark..."
          autoFocus
        />
      </label>
      {searching && <p>Searching verified locations...</p>}
      {error && <p className="location-picker-error">{error}</p>}
      {results.length > 0 && (
        <div className="location-results">
          {results.map((location) => (
            <button
              key={location.id}
              disabled={saving}
              onClick={() => void assign(location)}
            >
              <span>{countryFlag(location.countryCode)}</span>
              <div>
                <strong>{location.label}</strong>
                <small>
                  {location.latitude.toFixed(4)},{" "}
                  {location.longitude.toFixed(4)}
                </small>
              </div>
            </button>
          ))}
        </div>
      )}
      <footer>
        <span>Verified by OpenStreetMap</span>
        <button disabled={saving} onClick={() => void clear()}>
          Use embedded location
        </button>
      </footer>
    </section>
  );
}
