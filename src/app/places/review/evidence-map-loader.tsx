"use client";
import dynamic from "next/dynamic";
import type { EvidencePin } from "./evidence-map";

const EvidenceMap = dynamic(() => import("./evidence-map"), {
  ssr: false,
  loading: () => (
    <div className="map-canvas loading evidence-map" role="status">
      Loading the map…
    </div>
  ),
});

export function EvidenceMapLoader(props: { pins: EvidencePin[]; streetUrl: string | null }) {
  return <EvidenceMap {...props} />;
}
