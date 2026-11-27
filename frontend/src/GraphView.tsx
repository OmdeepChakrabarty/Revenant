/**
 * GraphView.tsx — Feature 4, macro view.
 * react-force-graph-2d renders the document graph; every incoming SSE `hop`
 * fires emitParticle() on the matching link, and the active node gets a halo.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { GraphData, TraversalHop } from "./xanadu";

interface GraphViewProps {
  graph: GraphData;
  activeNodeId: string | null;
  hop: TraversalHop | null;
  onSelectNode: (docId: string) => void;
}

function nodeId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) return String((value as { id: string }).id);
  return "";
}

export default function GraphView({ graph, activeNodeId, hop, onSelectNode }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<any>(null);
  const lastStep = useRef(0);
  const [width, setWidth] = useState(300);

  // ForceGraph mutates its data, so hand it a private copy.
  const data = useMemo(
    () => ({
      nodes: graph.nodes.map((node) => ({ ...node })),
      links: graph.links.map((link) => ({ ...link })),
    }),
    [graph],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 300;
      setWidth(Math.max(180, Math.floor(next)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!hop) return;
    if (hop.step <= lastStep.current) return;
    lastStep.current = hop.step;
    const fg = graphRef.current;
    if (!fg) return;
    const link = data.links.find(
      (candidate) =>
        nodeId(candidate.source) === hop.fromDocId && nodeId(candidate.target) === hop.toDocId,
    );
    if (link) {
      try {
        fg.emitParticle(link);
      } catch {
        /* graph may still be initialising on the first hop */
      }
    }
  }, [hop, data]);

  return (
    <div className="graph-box" ref={containerRef}>
      <ForceGraph2D
        ref={graphRef}
        graphData={data}
        width={width}
        height={300}
        backgroundColor="#0c1017"
        cooldownTicks={90}
        d3AlphaDecay={0.03}
        linkColor={() => "rgba(125,211,252,0.28)"}
        linkWidth={1.2}
        linkDirectionalParticles={2}
        linkDirectionalParticleWidth={2.4}
        linkDirectionalParticleSpeed={0.006}
        linkDirectionalParticleColor={() => "#a78bfa"}
        onNodeClick={(node: any) => onSelectNode(String(node.id))}
        nodeRelSize={5}
        nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, scale: number) => {
          const active = node.id === activeNodeId;
          const radius = active ? 7 : 5;
          if (active) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, radius + 7, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(125,211,252,0.16)";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(node.x, node.y, radius + 3, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(125,211,252,0.75)";
            ctx.lineWidth = 1.4;
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
          ctx.fillStyle = active ? "#7dd3fc" : node.id === hop?.toDocId ? "#a78bfa" : "#4b5c74";
          ctx.fill();

          const label = String(node.label ?? node.id);
          const fontSize = Math.max(9 / scale, 2.6);
          ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = active ? "#dff4ff" : "#8b97ab";
          ctx.fillText(label, node.x, node.y + radius + 2);
        }}
        nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x, node.y, 9, 0, Math.PI * 2);
          ctx.fill();
        }}
      />
      <div className="graph-hint">{graph.nodes.length} docs · {graph.links.length} spans</div>
    </div>
  );
}
