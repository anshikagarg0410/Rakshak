import React, { useCallback, useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap, Circle } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-routing-machine/dist/leaflet-routing-machine.css";
import "leaflet-routing-machine";

// Fix default icon issue
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const fireIcon = new L.Icon({
  iconUrl: "https://cdn-icons-png.flaticon.com/512/426/426833.png",
  iconSize: [35, 35],
  iconAnchor: [17, 35],
  popupAnchor: [0, -35],
});

// Hotspot icon — pulsing orange warning pin
const hotspotIcon = new L.DivIcon({
  className: "",
  html: `
    <div style="position:relative;width:48px;height:48px;display:flex;align-items:center;justify-content:center;">
      <div style="
        position:absolute;
        width:48px;height:48px;
        border-radius:50%;
        background:rgba(234,88,12,0.25);
        animation:pulse 1.6s ease-out infinite;
      "></div>
      <div style="
        position:absolute;
        width:32px;height:32px;
        border-radius:50%;
        background:rgba(234,88,12,0.45);
        animation:pulse 1.6s ease-out infinite 0.3s;
      "></div>
      <div style="
        position:relative;
        width:22px;height:22px;
        border-radius:50%;
        background:#ea580c;
        border:2.5px solid #fff;
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 2px 8px rgba(0,0,0,0.35);
        font-size:12px;font-weight:700;color:#fff;
        z-index:10;
      ">⚠</div>
    </div>
    <style>
      @keyframes pulse {
        0%   { transform:scale(0.6); opacity:0.8; }
        100% { transform:scale(1.8); opacity:0; }
      }
    </style>
  `,
  iconSize: [48, 48],
  iconAnchor: [24, 24],
  popupAnchor: [0, -28],
});

type LatLng = [number, number];

interface Incident {
  id: number;
  latitude: string;
  longitude: string;
  incident_type: string;
  description: string;
  date_created: string;
}

interface Hotspot {
  center: LatLng;
  incidents: Incident[];
  incidentCount: number;
}

async function getAddress(lat: number, lng: number): Promise<string> {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`
    );
    const data = await response.json();
    return data.display_name || "Unknown Location";
  } catch {
    return `Location (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
  }
}

// Fetch incidents within 500 m radius from a given point
async function fetchIncidentsNearPoint(
  lat: number,
  lng: number
): Promise<Incident[]> {
  try {
    const res = await fetch(
      `http://127.0.0.1:8000/incident/within-radius/?latitude=${lat}&longitude=${lng}&distance_km=0.5`
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (data.success && data.incident_count >= 3) {
      return data.incidents as Incident[];
    }
    return [];
  } catch {
    return [];
  }
}

function AutoFitBounds({ incidents }: { incidents: any[] }) {
  const map = useMap();
  useEffect(() => {
    if (incidents.length === 0) return;
    const bounds = L.latLngBounds(incidents.map((i) => i.position));
    map.fitBounds(bounds, { padding: [50, 50] });
  }, [incidents, map]);
  return null;
}

function RoutingMachine({ destination }: { destination: LatLng | null }) {
  const map = useMap();
  const routingRef = useRef<any>(null);

  useEffect(() => {
    if (!destination || !map) return;
    let control: any;

    navigator.geolocation.getCurrentPosition((position) => {
      const userLatLng = L.latLng(
        position.coords.latitude,
        position.coords.longitude
      );
      const destLatLng = L.latLng(destination[0], destination[1]);

      if (routingRef.current) map.removeControl(routingRef.current);

      control = (L as any).Routing.control({
        waypoints: [userLatLng, destLatLng],
        lineOptions: { styles: [{ color: "red", weight: 6 }] },
        show: false,
        addWaypoints: false,
      }).addTo(map);

      routingRef.current = control;
    });

    return () => {
      if (control) map.removeControl(control);
    };
  }, [destination, map]);

  return null;
}

// Deduplicate hotspots so nearby camera incidents don't generate multiple hotspot calls
function clusterPoints(points: LatLng[], radiusKm: number): LatLng[] {
  const used = new Set<number>();
  const clusters: LatLng[] = [];

  const toRad = (d: number) => (d * Math.PI) / 180;
  const haversine = (a: LatLng, b: LatLng) => {
    const R = 6371;
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  };

  for (let i = 0; i < points.length; i++) {
    if (used.has(i)) continue;
    clusters.push(points[i]);
    for (let j = i + 1; j < points.length; j++) {
      if (haversine(points[i], points[j]) <= radiusKm) used.add(j);
    }
    used.add(i);
  }

  return clusters;
}

export default function UserReportMap() {
  const [destination, setDestination] = useState<LatLng | null>(null);
  const [fireIncidents, setFireIncidents] = useState<any[]>([]);
  const [hotspots, setHotspots] = useState<Hotspot[]>([]);


useEffect(() => {
  const interval = setInterval(async () => {
    console.log("🔄 Running hotspot detection cycle...");

    try {
      const res = await fetch("http://127.0.0.1:8000/incident/get-all/");
      const data = await res.json();

      if (!data.success) {
        console.log("❌ Failed to fetch incidents");
        return;
      }

      const incidents = data.incidents;

      console.log("📦 Total incidents fetched:", incidents.length);
      console.log("📦 Incidents:", incidents);

      const newHotspots: Hotspot[] = [];
      const used = new Set<number>();

      for (let i = 0; i < incidents.length; i++) {
        if (used.has(i)) continue;

        const base = incidents[i];

        console.log(`\n👉 Checking incident ${i}`);
        console.log("📍 Base incident:", base);

        const res2 = await fetch(
          `http://127.0.0.1:8000/incident/within-radius/?latitude=${base.latitude}&longitude=${base.longitude}&distance_km=0.5`
        );

        const data2 = await res2.json();

        console.log("🌐 API response:", data2);

        if (!data2.success) {
          console.log("❌ API failed");
          continue;
        }

        const sameType = data2.incidents.filter(
          (inc: any) => inc.incident_type === base.incident_type
        );

        console.log("🧪 Same type incidents:", sameType.length);
        console.log("🧪 Same type list:", sameType);

        if (sameType.length >= 3) {
          console.log("🔥🔥 HOTSPOT DETECTED!");
          console.log("📍 Center:", base.latitude, base.longitude);
          console.log("📊 Count:", sameType.length);

          const center: LatLng = [
            parseFloat(base.latitude),
            parseFloat(base.longitude),
          ];

          newHotspots.push({
            center,
            incidents: sameType,
            incidentCount: sameType.length,
          });

          sameType.forEach((inc: any) => {
            const index = incidents.findIndex((x: any) => x.id === inc.id);
            if (index !== -1) used.add(index);
          });
        }
      }

      console.log("✅ Final hotspots:", newHotspots);
      console.log("🗺️ Updating hotspots state...");

      setHotspots(newHotspots);
    } catch (err) {
      console.error("❌ Hotspot fetch error", err);
    }
  }, 5000);

  return () => clearInterval(interval);
}, []);

  return (
    <div
      style={{
        height: "600px",
        width: "100%",
        borderRadius: "12px",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Legend */}
      {hotspots.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            zIndex: 1000,
            background: "rgba(255,255,255,0.95)",
            borderRadius: 8,
            padding: "8px 14px",
            boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
            fontSize: 13,
            fontFamily: "sans-serif",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 16 }}>⚠️</span>
          <span>
            <strong style={{ color: "#ea580c" }}>{hotspots.length}</strong>{" "}
            high-density hotspot{hotspots.length > 1 ? "s" : ""} detected
          </span>
        </div>
      )}

      <MapContainer
        center={[28.6139, 77.209]}
        zoom={12}
        scrollWheelZoom={true}
        style={{ height: "100%", width: "100%" }}
      >
        <AutoFitBounds incidents={fireIncidents} />

        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* ── Live camera alert markers ── */}
        {fireIncidents.map((incident) => (
          <Marker
            key={incident.id}
            position={incident.position}
            icon={fireIcon}
          >
            <Popup>
              <div style={{ textAlign: "center", minWidth: 160 }}>
                <strong
                  style={{
                    color: "#e11d48",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  {incident.title}
                </strong>
                <p
                  style={{
                    fontSize: 12,
                    color: "#666",
                    margin: "0 0 8px 0",
                  }}
                >
                  {incident.locationName}
                </p>
                <button
                  onClick={() => setDestination(incident.position)}
                  style={{
                    backgroundColor: "#e11d48",
                    color: "white",
                    border: "none",
                    padding: "6px 12px",
                    borderRadius: 4,
                    cursor: "pointer",
                    width: "100%",
                  }}
                >
                  Navigate Now
                </button>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* ── Hotspot markers + 500 m radius circle ── */}
        {hotspots.map((hs, idx) => (
          <React.Fragment key={`hs-${idx}`}>
            {/* Shaded radius ring */}
            <Circle
              center={hs.center}
              radius={500}
              pathOptions={{
                color: "#ea580c",
                fillColor: "#ea580c",
                fillOpacity: 0.08,
                weight: 2,
                dashArray: "6 4",
              }}
            />

            {/* Pulsing hotspot marker */}
            <Marker position={hs.center} icon={hotspotIcon}>
              <Popup>
                <div style={{ minWidth: 200, fontFamily: "sans-serif" }}>
                  <div
                    style={{
                      background: "#ea580c",
                      color: "#fff",
                      borderRadius: "6px 6px 0 0",
                      padding: "8px 12px",
                      margin: "-8px -8px 10px -8px",
                      fontWeight: 700,
                      fontSize: 13,
                    }}
                  >
                    ⚠️ Incident Hotspot
                  </div>
                  <p
                    style={{
                      margin: "0 0 8px 0",
                      fontSize: 12,
                      color: "#555",
                    }}
                  >
                    <strong>{hs.incidentCount} incidents</strong> within 500 m
                    of this point
                  </p>

                  {/* Breakdown list */}
                  <ul
                    style={{
                      margin: "0 0 10px 0",
                      paddingLeft: 16,
                      fontSize: 12,
                      color: "#444",
                    }}
                  >
                    {hs.incidents.slice(0, 5).map((inc) => (
                      <li key={inc.id} style={{ marginBottom: 3 }}>
                        <span
                          style={{
                            textTransform: "capitalize",
                            fontWeight: 600,
                            color:
                              inc.incident_type === "fire"
                                ? "#e11d48"
                                : "#ea580c",
                          }}
                        >
                          {inc.incident_type}
                        </span>{" "}
                        — {new Date(inc.date_created).toLocaleTimeString()}
                      </li>
                    ))}
                    {hs.incidents.length > 5 && (
                      <li style={{ color: "#888" }}>
                        +{hs.incidents.length - 5} more…
                      </li>
                    )}
                  </ul>

                  <button
                    onClick={() => setDestination(hs.center)}
                    style={{
                      background: "#ea580c",
                      color: "#fff",
                      border: "none",
                      padding: "6px 12px",
                      borderRadius: 4,
                      cursor: "pointer",
                      width: "100%",
                      fontWeight: 600,
                      fontSize: 12,
                    }}
                  >
                    Navigate to Hotspot
                  </button>
                </div>
              </Popup>
            </Marker>
          </React.Fragment>
        ))}

        <RoutingMachine destination={destination} />
      </MapContainer>
    </div>
  );
}
