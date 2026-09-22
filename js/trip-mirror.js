(() => {
  const bindings = new Map();
  let driverMap = null;
  function getDriverMap() {
    const container = document.getElementById("driverTripMap");
    if (!container || !window.google?.maps) return null;
    if (!driverMap) driverMap = new google.maps.Map(container, {
      center: { lat: 10.3157, lng: 123.8854 }, zoom: 15, disableDefaultUI: true, zoomControl: true
    });
    return driverMap;
  }
  function stop(role) {
    const b = bindings.get(role);
    if (!b) return;
    bindings.delete(role);
    b.unsubscribe?.();
    cancelAnimationFrame(b.frame);
    b.marker?.setMap(null);
    b.line?.setMap(null);
  }
  function render(b, state) {
    if (bindings.get(b.role) !== b) return;
    b.state = state;
    b.options.onState?.(state);
    cancelAnimationFrame(b.frame);
    if (state.phase === "pending" || state.phase === "cancelled") return;
    const route = ["pickup", "waiting"].includes(state.phase) ? state.pickupRoute : state.delivery;
    try {
      b.path = TripMotion.measurePath(TripMotion.decodePolyline(route?.polyline));
    } catch (error) {
      console.error("[Trip mirror] Invalid route:", error.message);
      b.options.onError?.("Trip route is unavailable. Please contact dispatch.");
      return;
    }
    const key = `${state.phase}:${route.polyline}`;
    const waitingSince = Date.now();
    let transitionStart = null;
    let oldPosition = null;
    function tick() {
      if (bindings.get(b.role) !== b) return;
      const map = b.options.map();
      if (!map || !window.google?.maps) {
        if (Date.now() - waitingSince > 15_000) {
          b.options.onError?.("The map could not load. Reconnect and reopen the trip.");
          return;
        }
        b.frame = requestAnimationFrame(tick);
        return;
      }
      if (b.routeKey !== key) {
        const routeChanged = b.polyline !== route.polyline;
        b.polyline = route.polyline;
        oldPosition = b.marker?.getPosition()?.toJSON() || null;
        transitionStart = Date.now();
        b.routeKey = key;
        if (!b.line) b.line = new google.maps.Polyline({ map, strokeColor: "#2563eb", strokeWeight: 5, strokeOpacity: 0.85 });
        b.line.setPath(b.path.points);
        if (!b.marker) b.marker = new google.maps.Marker({ map, title: "Estimated position — not live GPS", label: "🚘" });
        const bounds = new google.maps.LatLngBounds();
        b.path.points.forEach(p => bounds.extend(p));
        google.maps.event.trigger(map, "resize");
        if (!b.hasFramed || routeChanged) { map.fitBounds(bounds, 50); b.hasFramed = true; }
        else map.panToBounds(bounds, 50);
      }
      const clock = window.accountAuth?.serverTime?.() || Date.now();
      const progress = TripMotion.phaseProgress(state, clock);
      let position = state.phase === "waiting" ? state.pickup
        : state.phase === "completed" ? state.destination : TripMotion.atProgress(b.path, progress);
      const transition = Math.min(1, (Date.now() - transitionStart) / 700);
      if (oldPosition && transition < 1 && state.phase !== "waiting") {
        const t = transition * transition * (3 - 2 * transition);
        position = { lat: oldPosition.lat + (position.lat - oldPosition.lat) * t,
          lng: oldPosition.lng + (position.lng - oldPosition.lng) * t };
      }
      b.marker.setPosition(position);
      if (["pickup", "delivery"].includes(state.phase)
          || (state.phase !== "waiting" && transition < 1)) b.frame = requestAnimationFrame(tick);
    }
    tick();
  }
  function bind(role, id, options) {
    if (bindings.get(role)?.id === id) { bindings.get(role).options = options; return; }
    stop(role);
    const b = { role, id, options, frame: 0 };
    bindings.set(role, b);
    b.unsubscribe = db.collection("ride_orders").doc(id).collection("trip_state").doc("current").onSnapshot(doc => {
      if (bindings.get(role) !== b) return;
      if (!doc.exists) { b.options.onError?.("Trip route snapshot is unavailable. Contact dispatch."); return; }
      render(b, doc.data());
    }, error => {
      if (bindings.get(role) !== b) return;
      console.error("[Trip mirror] Subscription failed:", error.code);
      cancelAnimationFrame(b.frame);
      b.options.onError?.("Unable to load trip estimates. Please reconnect.");
    });
  }
  function showShared(id, state, options) {
    let b = bindings.get("viewer");
    if (!b || b.id !== id) {
      stop("viewer");
      b = { role: "viewer", id, options, frame: 0 };
      bindings.set("viewer", b);
    }
    render(b, state);
  }
  window.tripMirror = {
    bind, stop, showShared, getDriverMap,
    stopAll() { [...bindings.keys()].forEach(stop); }
  };
})();
