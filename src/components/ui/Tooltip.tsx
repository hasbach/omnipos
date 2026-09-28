import React from 'react';

/** Lightweight tooltip: native title attribute is accessible-enough and needs no portal/positioning logic. */
export function Tooltip({ label, children }: { label: string; children: React.ReactElement<{ title?: string }> }) {
  return React.cloneElement(children, { title: label });
}

export default Tooltip;
