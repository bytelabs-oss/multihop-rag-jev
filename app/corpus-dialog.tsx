'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

export function CorpusDialog({
  onClose,
  onLoad,
}: {
  onClose: () => void;
  onLoad: (count: number, selection: 'first' | 'random') => void;
}) {
  const [count, setCount] = useState(20);
  const [selection, setSelection] = useState<'first' | 'random'>('first');

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="corpus-dialog gap-0 sm:max-w-none" showCloseButton={false}>
        <DialogHeader className="text-left">
          <DialogTitle>Load MultiHop-RAG</DialogTitle>
          <DialogDescription asChild>
            <p>609 news articles from the MultiHop-RAG dataset by Yixuan Tang and Yi Yang. The corpus is bundled with this app; no file selection is needed.</p>
          </DialogDescription>
        </DialogHeader>
        <p>Articles use 256-token sentence chunks with 25-token overlap. Existing cached embeddings are reused. Only the selected articles are processed. This replaces the currently loaded dataset articles and keeps your own uploads.</p>
        <label>
          <span>Articles</span>
          <NativeSelect value={String(count)} onChange={event => setCount(Number(event.target.value))}>
            {[10, 20, 50, 100, 609].map(value => (
              <NativeSelectOption key={value} value={value}>
                {value === 609 ? 'All 609' : value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label>
          <span>Selection</span>
          <NativeSelect value={selection} onChange={event => setSelection(event.target.value as 'first' | 'random')}>
            <NativeSelectOption value="first">First articles in dataset order</NativeSelectOption>
            <NativeSelectOption value="random">Random sample · fixed seed 42</NativeSelectOption>
          </NativeSelect>
        </label>
        <p className="quiet">This count selects articles, not questions. The question picker will offer only answerable questions whose source articles are all loaded. Loading more articles can make more questions available. Questions and reference answers are not indexed.</p>
        <p><a href="https://huggingface.co/datasets/yixuantt/MultiHopRAG" target="_blank" rel="noreferrer">Dataset</a> · <a href="/datasets/multihop-rag/ATTRIBUTION.md" target="_blank" rel="noreferrer">Attribution · ODC-BY 1.0</a></p>
        <DialogFooter className="dialog-actions">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onLoad(count, selection)}>Load {count} articles</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
