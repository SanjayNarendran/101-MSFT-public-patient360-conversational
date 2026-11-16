import { useEffect, useRef } from 'react';

import { mountDiscovery } from '@/discovery/controller';
import '@/discovery/discovery.css';

/** The Discovery tab: Copilot chat, ontology, query builder and results (see discovery/controller.ts). */
export function Discovery() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => mountDiscovery(ref.current!), []);
  return <div className="disc" ref={ref} />;
}
