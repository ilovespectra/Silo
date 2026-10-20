import assert from "node:assert/strict";
import {
  distanceMeters,
  inferBorrowedLocations,
  type BorrowedLocationSample,
} from "../src/borrowedLocationInference";

function sample(
  path: string,
  captureTime: number,
  latitude?: number,
  longitude?: number,
  cameraKey?: string,
): BorrowedLocationSample {
  return { path, captureTime, latitude, longitude, cameraKey };
}

const minute = 60_000;

{
  const time = Date.UTC(2025, 4, 1, 10, 0);
  const suggestions = inferBorrowedLocations([
    sample("gps-a", time - minute, 46.05, 14.50),
    sample("gps-b", time, 46.05005, 14.50005),
    sample("gps-c", time + minute, 46.04995, 14.49995),
    sample("camera", time + 30_000),
  ]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].confidence, "high");
  assert.equal(suggestions[0].referenceCount, 3);
  assert.ok(distanceMeters(suggestions[0], { latitude: 46.05, longitude: 14.5 }) < 20);
}

{
  const time = Date.UTC(2025, 4, 1, 10, 0);
  const suggestions = inferBorrowedLocations([
    sample("gps", time, 46.0, 14.0),
    { path: "camera-null-gps", captureTime: time + minute, latitude: null, longitude: null },
  ]);
  assert.equal(suggestions.length, 1, "null GPS fields must be treated as missing, not as 0,0");
  assert.equal(suggestions[0].latitude, 46.0);
  assert.equal(suggestions[0].longitude, 14.0);
}

{
  const time = Date.UTC(2025, 4, 1, 10, 0);
  const suggestions = inferBorrowedLocations([
    sample("gps-before", time, 46.0, 14.0),
    sample("gps-after", time + 10 * minute, 46.0, 14.01),
    sample("camera", time + 5 * minute),
  ]);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].method, "interpolated");
  assert.equal(suggestions[0].confidence, "medium");
  assert.ok(Math.abs(suggestions[0].longitude - 14.005) < 0.0001);
}

{
  const time = Date.UTC(2025, 4, 1, 10, 0);
  const suggestions = inferBorrowedLocations([
    sample("gps-before", time, 0, 0),
    sample("gps-after", time + 10 * minute, 40, 40),
    sample("camera", time + 5 * minute),
  ]);
  assert.equal(suggestions.length, 0, "an impossible travel speed must not be interpolated");
}

{
  const time = Date.UTC(2025, 4, 1, 10, 0);
  assert.equal(
    inferBorrowedLocations([
      sample("gps", time, 46.0, 14.0),
      sample("outside", time + 16 * minute),
    ]).length,
    0,
  );
  assert.equal(
    inferBorrowedLocations(
      [sample("gps", time, 46.0, 14.0), sample("outside", time + 16 * minute)],
      { windowMinutes: 30 },
    ).length,
    1,
  );
}

{
  const time = Date.UTC(2025, 4, 1, 8, 0);
  const suggestions = inferBorrowedLocations([
    sample("camera-a", time, undefined, undefined, "Canon EOS R6"),
    sample("camera-b", time + 60 * minute, undefined, undefined, "Canon EOS R6"),
    sample("camera-c", time + 120 * minute, undefined, undefined, "Canon EOS R6"),
    sample("gps-a", time + 5 * minute, 46.0, 14.0),
    sample("gps-b", time + 65 * minute, 46.1, 14.1),
    sample("gps-c", time + 125 * minute, 46.2, 14.2),
  ]);
  assert.equal(suggestions.length, 3);
  for (const suggestion of suggestions) {
    assert.ok(suggestion.timeOffsetMs >= 4 * minute);
    assert.ok(suggestion.timeOffsetMs <= 6 * minute);
  }
}

console.log("Borrowed-location inference tests passed.");
