import React, { useCallback } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';

interface PlanCanvasProps {
  elements: string; // JSON string
  onUpdate: (elements: string) => void;
}

export function PlanCanvas({ elements, onUpdate }: PlanCanvasProps) {
  const initialData = React.useMemo(() => {
    try { return { elements: JSON.parse(elements) }; } catch { return { elements: [] }; }
  }, []); // Only parse once on mount

  const handleChange = useCallback((els: readonly OrderedExcalidrawElement[], _appState: AppState, _files: BinaryFiles) => {
    onUpdate(JSON.stringify(els));
  }, [onUpdate]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Excalidraw
        initialData={initialData}
        onChange={handleChange}
        UIOptions={{ canvasActions: { export: false, loadScene: false } }}
      />
    </div>
  );
}
