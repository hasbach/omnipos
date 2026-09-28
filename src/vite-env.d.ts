/// <reference types="vite/client" />

// Pre-existing code (src/components/LabelPrinter.tsx) annotates a return type with the global
// `JSX.Element`, which React 19's types no longer declare globally — alias it to React's.
import type { JSX as ReactJSX } from 'react';
declare global {
  namespace JSX {
    type Element = ReactJSX.Element;
  }
}

export {};
