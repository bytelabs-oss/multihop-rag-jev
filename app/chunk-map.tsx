'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { Minus, Plus, Maximize } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Node = { id: string; x: number; y: number; color: string; docName: string; index: number };

export const ChunkMap = memo(function ChunkMap({
  nodes,
  visible,
  selected,
  candidates,
  kept,
  onSelect,
}: {
  nodes: Node[];
  visible: Set<string>;
  selected: string | null;
  candidates: Set<string>;
  kept: Set<string>;
  onSelect: (id: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const transform = useRef({ x: 0, y: 0, zoom: 1 });
  const paint = useRef(() => {});
  const frame = useRef(0);
  const pointer = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [percent, setPercent] = useState(100);

  function schedule() {
    if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; paint.current(); });
  }

  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext('2d')!;
    paint.current = () => {
      const { width: w, height: h } = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const t = transform.current;
      const scale = Math.min(w / 800, h / 600) * t.zoom;
      for (const n of nodes) {
        if (!visible.has(n.id)) continue;
        const x = w / 2 + t.x + n.x * scale;
        const y = h / 2 + t.y + n.y * scale;
        if (x < -15 || x > w + 15 || y < -15 || y > h + 15) continue;
        ctx.globalAlpha = candidates.size && !candidates.has(n.id) ? 0.18 : 1;
        ctx.fillStyle = kept.has(n.id) ? '#c7ec85' : candidates.has(n.id) ? '#eeaf6b' : n.color;
        ctx.beginPath();
        ctx.arc(x, y, n.id === selected ? 6 : candidates.has(n.id) ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fill();
        if (n.id === selected) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = n.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, 11, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [nodes, visible, selected, candidates, kept]);

  function zoom(factor: number) {
    transform.current.zoom = Math.max(0.4, Math.min(4, transform.current.zoom * factor));
    setPercent(Math.round(transform.current.zoom * 100));
    schedule();
  }

  return <>
    <canvas
      ref={canvas}
      className="chunk-canvas"
      tabIndex={0}
      role="img"
      aria-label={`${visible.size} document chunks. Click a point to inspect it. Use arrow keys to select chunks, or use List view.`}
      onWheel={event => zoom(event.deltaY > 0 ? 0.9 : 1.1)}
      onPointerDown={event => {
        const t = transform.current;
        pointer.current = { x: event.clientX, y: event.clientY, ox: t.x, oy: t.y, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const p = pointer.current;
        if (!p) return;
        const dx = event.clientX - p.x;
        const dy = event.clientY - p.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) p.moved = true;
        transform.current.x = p.ox + dx;
        transform.current.y = p.oy + dy;
        schedule();
      }}
      onPointerUp={event => {
        const p = pointer.current;
        pointer.current = null;
        if (!p || p.moved) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const t = transform.current;
        const scale = Math.min(rect.width / 800, rect.height / 600) * t.zoom;
        let nearest: Node | undefined;
        let best = 144;
        for (const n of nodes) {
          if (!visible.has(n.id)) continue;
          const dx = rect.width / 2 + t.x + n.x * scale - (event.clientX - rect.left);
          const dy = rect.height / 2 + t.y + n.y * scale - (event.clientY - rect.top);
          const distance = dx * dx + dy * dy;
          if (distance < best) {
            best = distance;
            nearest = n;
          }
        }
        if (nearest) onSelect(nearest.id);
      }}
      onPointerCancel={() => { pointer.current = null; }}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const options = nodes.filter(node => visible.has(node.id));
        if (!options.length) return;
        const index = options.findIndex(node => node.id === selected);
        const delta = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
        onSelect(options[(index + delta + options.length) % options.length].id);
      }}
    />
    <div className="map-caption">
      <span>2D · PCA · {visible.size.toLocaleString()} points</span>
      {candidates.size > 0 && <span>Orange: retrieved · Green: kept</span>}
    </div>
    <div className="zoom-controls">
      <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => zoom(0.8)}>
        <Minus size={16} />
      </Button>
      <span>{percent}%</span>
      <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => zoom(1.25)}>
        <Plus size={16} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Reset view"
        onClick={() => {
          transform.current = { x: 0, y: 0, zoom: 1 };
          setPercent(100);
          schedule();
        }}
      >
        <Maximize size={16} />
      </Button>
    </div>
  </>;
});
