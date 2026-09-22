(function (root) {
  function decodePolyline(encoded) {
    if (typeof encoded !== "string" || !encoded.length) throw new Error("Missing route geometry.");
    let index = 0, lat = 0, lng = 0;
    const points = [];
    function delta() {
      let result = 0, shift = 0, byte;
      do {
        if (index >= encoded.length || shift > 30) throw new Error("Invalid route geometry.");
        byte = encoded.charCodeAt(index++) - 63;
        if (byte < 0 || byte > 63) throw new Error("Invalid route geometry.");
        result |= (byte & 31) << shift;
        shift += 5;
      } while (byte >= 32);
      return result & 1 ? ~(result >> 1) : result >> 1;
    }
    while (index < encoded.length) {
      lat += delta(); lng += delta();
      points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return points;
  }
  function measurePath(points) {
    const lengths = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const radians = Math.PI / 180;
      const x = Math.sin((b.lat - a.lat) * radians / 2) ** 2
        + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin((b.lng - a.lng) * radians / 2) ** 2;
      lengths.push(lengths[i - 1] + 6_371_000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x))));
    }
    return { points, lengths, total: lengths[lengths.length - 1] };
  }
  function atProgress(path, progress) {
    const target = path.total * Math.max(0, Math.min(1, progress));
    if (!path.points.length) throw new Error("The route has no points.");
    if (!path.total) return path.points[0];
    let lo = 1, hi = path.lengths.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (path.lengths[mid] < target) lo = mid + 1; else hi = mid; }
    const a = path.points[lo - 1], b = path.points[lo];
    const span = path.lengths[lo] - path.lengths[lo - 1];
    const t = span > 0 ? (target - path.lengths[lo - 1]) / span : 0;
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  }
  function phaseProgress(state, clock) {
    if (state.phase === "waiting" || state.phase === "completed") return 1;
    const route = state.phase === "pickup" ? state.pickupRoute : state.delivery;
    if (!route || !Number.isFinite(route.durationSeconds) || route.durationSeconds <= 0) throw new Error("Invalid route duration.");
    return Math.max(0, Math.min(0.9, (clock - state.phaseStartedAt) / (route.durationSeconds * 1000)));
  }
  const api = { decodePolyline, measurePath, atProgress, phaseProgress };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TripMotion = api;
})(globalThis);
