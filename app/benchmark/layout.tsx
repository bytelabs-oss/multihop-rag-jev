import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'MultiHop-RAG benchmark | Atlas' };

export default function BenchmarkLayout({ children }: { children: ReactNode }) {
  return children;
}
