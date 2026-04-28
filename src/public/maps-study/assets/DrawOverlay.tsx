import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { SegmentedControl } from '@mantine/core';
import classes from './Map.module.css';

type Point = [number, number];
type Polygon = Point[];

function closePolygon(poly: Polygon): Polygon {
  if (poly.length < 3) return poly;

  const [fx, fy] = poly[0];
  const [lx, ly] = poly[poly.length - 1];

  if (fx === lx && fy === ly) {
    return poly;
  }

  return [...poly, [fx, fy]];
}

const GRID_SIZE = 10; // pixels per cell

function pointInPolygon(point: Point, polygon: Polygon): boolean {
  let inside = false;
  const [x, y] = point;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    const intersect = yi > y !== yj > y
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

function DrawOverlay({
  height, width, addObject, objects, transform, isEnabled, heatmapEnabled = false,
}: {height: number, width: number, transform: d3.ZoomTransform, isEnabled:boolean, addObject: (v: number[][]) => void, objects: number[][][], heatmapEnabled?: boolean}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentDrawingRef = useRef<number[][]>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStarted, setDrawStarted] = useState(false);
  const [context, setContext] = useState<CanvasRenderingContext2D | null>(null);
  const [heatmapColor, setHeatmapColor] = useState('#00FF00');

  const [heatmap, heatmapRows, heatmapCols] = useMemo(() => {
    if (!heatmapEnabled) { return [[], 1, 1]; }
    const WIDTH = width / transform.k;
    const HEIGHT = height / transform.k;
    const cols = Math.ceil(WIDTH / GRID_SIZE);
    const rows = Math.ceil(HEIGHT / GRID_SIZE);

    const _heatmap = Array.from({ length: rows }, () => Array(cols).fill(0));
    const closedPolygons = (objects as Polygon[]).map(closePolygon);

    // fillup heatmap
    for (const polygon of closedPolygons) {
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const cx = c * GRID_SIZE + GRID_SIZE / 2;
          const cy = r * GRID_SIZE + GRID_SIZE / 2;

          if (pointInPolygon([cx, cy], polygon)) {
            _heatmap[r][c] += 1;
          }

          // const screenX = c * GRID_SIZE + GRID_SIZE / 2;
          // const screenY = r * GRID_SIZE + GRID_SIZE / 2;

          // const worldX = (screenX - transform.x) / transform.k;
          // const worldY = (screenY - transform.y) / transform.k;

          // if (pointInPolygon([worldX, worldY], polygon)) {
          //   _heatmap[r][c] += 1;
          // }
        }
      }
    }

    return [_heatmap, rows, cols];
  }, [height, width, objects, transform, heatmapEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.lineCap = 'round';
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'yellow';
        setContext(ctx);
      }
    }
  }, [height, width]);

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setDrawStarted(true);
    if (!context) return;
    context.save();

    context.beginPath();
    context.moveTo(e.nativeEvent.offsetX, e.nativeEvent.offsetY);

    const [x, y] = transform.invert([e.nativeEvent.offsetX, e.nativeEvent.offsetY]);
    currentDrawingRef.current = [[x, y]];
    setIsDrawing(true);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !context) return;
    context.lineTo(e.nativeEvent.offsetX, e.nativeEvent.offsetY);

    const [x, y] = transform.invert([e.nativeEvent.offsetX, e.nativeEvent.offsetY]);
    currentDrawingRef.current?.push([x, y]);
    context.lineWidth = 2;
    context.stroke();
  };

  const endDrawing = () => {
    if (drawStarted) {
      if (!context) return;
      context.closePath();
      setIsDrawing(false);
      context.restore();
      if (currentDrawingRef.current) {
        addObject(currentDrawingRef.current);
      }
      setDrawStarted(false);
    }
  };

  useEffect(() => {
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.save();

    context.setTransform(transform.k, 0, 0, transform.k, transform.x, transform.y);

    if (heatmapEnabled) {
      // Normalize (important for color mapping)
      const maxValue = Math.max(...heatmap.flat(), 1);

      // Draw heatmap cells
      for (let r = 0; r < heatmapRows; r += 1) {
        for (let c = 0; c < heatmapCols; c += 1) {
          const value = heatmap[r][c];

          if (value !== 0) {
            const intensity = value / maxValue;

            if (heatmapColor === 'red') {
              context.fillStyle = `rgba(255, 0, 0, ${intensity * 1})`;
            } else if (heatmapColor === 'green') {
              context.fillStyle = `rgba(0, 255, 0, ${intensity * 1})`;
            } else {
              context.fillStyle = `rgba(0, 0, 255, ${intensity * 1})`;
            }

            context.fillRect(
              c * GRID_SIZE,
              r * GRID_SIZE,
              GRID_SIZE,
              GRID_SIZE,
            );
          }
        }
      }
    } else {
      objects.forEach((o) => {
        context.beginPath();
        context.moveTo(o[0][0], o[0][1]);
        o.forEach((dot) => {
          context.lineTo(dot[0], dot[1]);
        });
        context.lineWidth = 2 / transform.k;
        context.stroke();
      });
    }

    context.restore();
  }, [objects, height, width, context, transform, heatmap, heatmapRows, heatmapCols, heatmapEnabled, heatmapColor]);

  return (
    <div>
      {heatmapEnabled
      && (
      <div style={{ position: 'absolute', top: 0, width: 300 }}>
        <SegmentedControl
          value={heatmapColor}
          onChange={setHeatmapColor}
          data={[
            { label: 'red', value: 'red' },
            { label: 'green', value: 'green' },
            { label: 'blue', value: 'blue' },
          ]}
        />
      </div>
      )}
      <div className={classes.drawOverlay} style={{ pointerEvents: isEnabled ? 'auto' : 'none' }}>
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={endDrawing}
          onMouseLeave={endDrawing}
          style={{ cursor: 'crosshair' }}
        />
      </div>
    </div>
  );
}

export default DrawOverlay;
