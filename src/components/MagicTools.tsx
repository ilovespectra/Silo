import React from "react";
import { FiCheckSquare } from "react-icons/fi";
import {
  MAGIC_PRESETS,
  MagicPresetId,
  MagicState,
} from "../utils/useMagicRanks";

interface MagicToolsProps {
  state: MagicState;
  preset: MagicPresetId;
  onPresetChange: (preset: MagicPresetId) => void;
  topCount: number;
  onTopCountChange: (count: number) => void;
  onSelectTop: (count: number) => void;
  compact?: boolean;
}

/** Preset picker, analysis progress, and "select the best N" for magic sort. */
export default function MagicTools({
  state,
  preset,
  onPresetChange,
  topCount,
  onTopCountChange,
  onSelectTop,
  compact,
}: MagicToolsProps) {
  const ranked = Object.keys(state.scores).length;
  const analyzing = state.total > 0 && state.analyzed < state.total;
  return (
    <div className={`magic-tools ${compact ? "compact" : ""}`}>
      <select
        value={preset}
        onChange={(event) =>
          onPresetChange(event.target.value as MagicPresetId)
        }
        title={MAGIC_PRESETS.find((item) => item.id === preset)?.description}
        aria-label="Magic style"
      >
        {MAGIC_PRESETS.map((item) => (
          <option key={item.id} value={item.id} title={item.description}>
            {"\u2726"} {item.label}
          </option>
        ))}
      </select>
      <form
        className="magic-top"
        onSubmit={(event) => {
          event.preventDefault();
          onSelectTop(topCount);
        }}
      >
        <span>Pick top</span>
        <input
          type="number"
          min={1}
          max={Math.max(1, ranked)}
          value={topCount}
          onChange={(event) =>
            onTopCountChange(
              Math.max(1, Math.floor(Number(event.target.value) || 1)),
            )
          }
          aria-label="Number of photos to select"
        />
        <button
          type="submit"
          disabled={ranked === 0}
          title="Select the highest-ranked photos"
        >
          <FiCheckSquare /> Select
        </button>
      </form>
      {analyzing && (
        <div
          className="magic-progress"
          title="Photos are analyzed on this Mac only. Nothing is uploaded."
        >
          <span>
            {"\u2726"} Analyzing {state.analyzed.toLocaleString()} of{" "}
            {state.total.toLocaleString()} locally
          </span>
          <progress value={state.analyzed} max={Math.max(state.total, 1)} />
        </div>
      )}
    </div>
  );
}
