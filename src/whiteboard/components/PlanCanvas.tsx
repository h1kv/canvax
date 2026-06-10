import React, { useCallback, useEffect, useRef } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';

interface PlanCanvasProps {
  elements: string; // JSON string
  onUpdate: (elements: string) => void;
}

export function PlanCanvas({ elements, onUpdate }: PlanCanvasProps) {
  const latestElementsRef = useRef(elements);
  const initialData = React.useMemo(() => {
    try { return { elements: JSON.parse(elements) }; } catch { return { elements: [] }; }
  }, [elements]);

  useEffect(() => {
    latestElementsRef.current = elements;
  }, [elements]);

  const handleChange = useCallback((els: readonly OrderedExcalidrawElement[], _appState: AppState, _files: BinaryFiles) => {
    const nextElements = JSON.stringify(els);
    if (nextElements === latestElementsRef.current) return;
    latestElementsRef.current = nextElements;
    onUpdate(nextElements);
  }, [onUpdate]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Excalidraw
        key={elements}
        initialData={initialData}
        onChange={handleChange}
        UIOptions={{ canvasActions: { export: false, loadScene: false } }}
      />
    </div>
  );
}
